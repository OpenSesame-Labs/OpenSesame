import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

export const AUTHORITY_HELP: readonly HelpTopic[] = [
  {
    id: "help.browser.pair",
    title: "Pair this browser",
    answer:
      "On a loopback or dedicated-origin deployment, select Pair this browser. Check the origin and code before approving. Pairing initially permits encrypted sync only. The shared-origin demo cannot pair.",
    routes: [],
    goal: "browser.pair",
    keywords: ["pair", "pairing", "local host", "user code"],
  },
  {
    id: "help.browser.authenticate",
    title: "Verify identity after pairing",
    answer:
      "When prompted, verify with a passkey. Verification cannot grant permissions beyond the paired role. Pairing or ordinary sign-in alone does not grant administration or browser control.",
    routes: [],
    goal: "browser.authenticate",
    keywords: ["verify identity", "host authorization", "passkey"],
  },
  {
    id: "help.agent.observe",
    title: "Review an authorized agent run",
    answer:
      "Access → Sessions lists authorized agent runs. Observation relays encrypted records; viewing them requires the matching viewer key. An ordinary agent session cannot turn observation into browser control.",
    routes: [],
    goal: "agent.observe",
    keywords: ["agent run", "observation", "viewer key"],
  },
  {
    id: "help.agent.control",
    title: "Verify before taking browser control",
    answer:
      "For an authorized run, request browser control and verify with a passkey. Approval applies only to that run and transition and can be used once. An expired control lease pauses the run.",
    routes: [],
    goal: "agent.control",
    keywords: ["browser control", "take control", "control lease"],
  },
];

export const AUTHORITY_GOALS: readonly GuideGoalDescriptor[] =
  AUTHORITY_HELP.map((topic) => {
    if (!topic.goal) throw new Error("authority_help_goal_missing");
    return {
      id: topic.goal,
      title: topic.title,
      routes: topic.goal.startsWith("agent.")
        ? ["/access"]
        : ["/settings/features", "/connections"],
      guide: [
        "guide/1",
        `goal "${topic.goal}"`,
        `say "${topic.answer}"`,
        "end",
      ].join("\n"),
    };
  });

export const AUTHORITY_TUTORIALS = {
  "browser.pairing.begin": "browser.pair",
  "browser.identity.authenticate": "browser.authenticate",
} as const;
