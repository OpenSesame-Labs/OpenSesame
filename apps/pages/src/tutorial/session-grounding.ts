import type { HelpTopic } from "@opensesame/app-core/tutorial/registry/goals.js";
import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import { rankHelpTopics } from "@opensesame/app-core/tutorial/registry/goals-search.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import type { GuideGoalId } from "@opensesame/guide-lang";
import type { SupportSessionSnapshot } from "@opensesame/support-agent";
import {
  NOTHING_WRITTEN_TEXT,
  UNVERIFIED_TEXT,
  citedHelpText,
  writtenHelpSaysText,
} from "./ui/messages.js";

export type SupportWalkthrough = {
  readonly goal: GuideGoalId;
  readonly title: string;
};

type PushEntry = (
  kind: "note",
  text: string,
  suggestions: readonly string[],
  traces?: { readonly walkthroughs?: readonly SupportWalkthrough[] },
) => void;

/** The authored walkthroughs behind a set of help topics, deduplicated. */
export function walkthroughsFor(
  topics: readonly { readonly goal: string | null }[],
): readonly SupportWalkthrough[] {
  const out: SupportWalkthrough[] = [];
  for (const topic of topics) {
    if (topic.goal === null) continue;
    const named = guideGoal(topic.goal);
    if (!named || out.some((held) => held.goal === named.id)) continue;
    out.push({ goal: named.id, title: named.title });
  }
  return out;
}

/**
 * What the person is told about where an answer came from — the one place
 * the written help overrides a model rather than merely informing it.
 */
export function noteGrounding(
  push: PushEntry,
  route: GuideRouteId,
  question: string,
  grounding: SupportSessionSnapshot["grounding"],
): void {
  if (grounding?.kind === "cited") {
    push(
      "note",
      citedHelpText(grounding.help.map((entry) => entry.title)),
      [],
      { walkthroughs: walkthroughsFor(grounding.help) },
    );
    return;
  }
  const best: HelpTopic | null =
    rankHelpTopics(question, route).find((entry) => entry.strong)?.topic ??
    null;
  if (best !== null) {
    push("note", writtenHelpSaysText(best.title, best.answer), [], {
      walkthroughs: walkthroughsFor([best]),
    });
    return;
  }
  push(
    "note",
    grounding?.kind === "none" ? NOTHING_WRITTEN_TEXT : UNVERIFIED_TEXT,
    [],
  );
}
