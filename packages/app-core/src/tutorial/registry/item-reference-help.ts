import type { HelpTopic } from "./goal-types.js";

export const ITEM_REFERENCE_HELP: readonly HelpTopic[] = [
  {
    id: "help.vault.item-references",
    title: "How do I make an environment template from an item?",
    answer:
      "Open the item and select Download reference template to download references to its secret fields. To export a plaintext .env, select Download plaintext .env and confirm. Use the field controls to reveal, copy or update an individual value.",
    routes: ["/vault"],
    goal: null,
    keywords: [
      "2password",
      "references",
      "environment",
      "template",
      "env",
      "credentials",
      "compare",
    ],
  },
];
