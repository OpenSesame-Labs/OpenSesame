import { HELP_TOPICS } from "@opensesame/app-core/tutorial/registry/goals.js";
import { rankHelpTopics } from "@opensesame/app-core/tutorial/registry/goals-search.js";
import type { GuideProgram } from "@opensesame/guide-lang";
import { gateSupportAsk } from "./ask-guard.js";
import type { SupportEngine } from "./engine.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import type { SupportEntryExtras, SupportEntryKind } from "./session.js";
import type { SupportView } from "./session.js";
import { noteGrounding, walkthroughsFor } from "./session-grounding.js";
import {
  GUIDE_REFUSED_TEXT,
  SUPPORT_ERROR_TEXT,
} from "./ui/messages.js";

export type SessionAskDeps = {
  push: (
    kind: SupportEntryKind,
    text: string,
    suggestions: readonly string[],
    traces?: SupportEntryExtras,
  ) => void;
  set: (patch: Partial<SupportView>) => void;
  view: () => SupportView;
  ensureEngine: () => Promise<SupportEngine | null>;
  engine: () => SupportEngine | null;
  cancelled: {
    get: () => boolean;
    set: (value: boolean) => void;
  };
  notifyFailure: (body: string) => void;
  refreshAvailability: () => Promise<void>;
  runProgram: (program: GuideProgram, origin: "model") => Promise<void>;
};

type AskSessionSnapshot = ReturnType<SupportEngine["session"]["snapshot"]>;

function pushAuthoredAnswer(
  deps: SessionAskDeps,
  text: string,
  route: GuideRouteId,
): boolean {
  const authored = rankHelpTopics(text, route).find((e) => e.strong)?.topic;
  if (!authored) return false;
  deps.push("answer", authored.answer, [], {
    walkthroughs: walkthroughsFor([authored]),
  });
  return true;
}

function pushAssistantReply(
  deps: SessionAskDeps,
  route: GuideRouteId,
  question: string,
  snapshot: AskSessionSnapshot,
): void {
  const last = snapshot.messages.at(-1);
  if (last?.role !== "assistant") return;
  deps.push("answer", last.text, snapshot.suggestedQuestions, {
    thoughts: snapshot.thoughts,
    computer: snapshot.computer,
  });
  if (snapshot.guideError) deps.notifyFailure(GUIDE_REFUSED_TEXT);
  noteGrounding(deps.push, route, question, snapshot.grounding);
}

async function handleAskSnapshot(
  deps: SessionAskDeps,
  text: string,
  route: GuideRouteId,
  snapshot: AskSessionSnapshot,
): Promise<boolean> {
  if (snapshot.status === "error") {
    const authored = rankHelpTopics(text, route).find((entry) => entry.strong)
      ?.topic;
    if (authored && snapshot.error === "AGENT_UNAVAILABLE") {
      deps.push("answer", authored.answer, [], {
        walkthroughs: walkthroughsFor([authored]),
      });
      void deps.refreshAvailability();
      return true;
    }
    deps.notifyFailure(
      SUPPORT_ERROR_TEXT[snapshot.error ?? "AGENT_PROTOCOL_ERROR"],
    );
    void deps.refreshAvailability();
    return true;
  }
  pushAssistantReply(deps, route, text, snapshot);
  if (snapshot.program) await deps.runProgram(snapshot.program, "model");
  return true;
}

export function createSessionAskMethods(deps: SessionAskDeps) {
  async function ask(question: string): Promise<void> {
    const state = deps.view();
    const gate = gateSupportAsk(question, state.thinking);
    if (gate.kind === "skip") return;
    const { text } = gate;
    deps.push("question", text, []);
    const loaded = await deps.ensureEngine();
    if (!loaded) {
      if (pushAuthoredAnswer(deps, text, state.route)) return;
      deps.notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
      return;
    }
    deps.cancelled.set(false);
    deps.set({ thinking: true });
    await loaded.session.ask(text);
    if (deps.engine() !== loaded) return;
    deps.set({ thinking: false });
    if (deps.cancelled.get()) {
      deps.cancelled.set(false);
      deps.push("note", SUPPORT_ERROR_TEXT.AGENT_ABORTED, []);
      return;
    }
    const snapshot = loaded.session.snapshot();
    await handleAskSnapshot(deps, text, state.route, snapshot);
  }

  function cancel(): void {
    const state = deps.view();
    if (!state.thinking) return;
    deps.cancelled.set(true);
    deps.engine()?.session.cancel();
  }

  function answerFromAuthoredHelp(question: string, answer: string): void {
    deps.push("question", question, []);
    const topic = HELP_TOPICS.find((entry) => entry.answer === answer);
    deps.push("answer", answer, [], {
      walkthroughs: topic ? walkthroughsFor([topic]) : [],
    });
  }

  return { ask, cancel, answerFromAuthoredHelp };
}