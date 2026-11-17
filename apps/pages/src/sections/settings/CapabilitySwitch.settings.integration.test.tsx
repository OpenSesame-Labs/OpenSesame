/** @vitest-environment jsdom */

import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { expect, it } from "vitest";
import {
  installPanelFixture,
  renderPanel,
} from "./settings-panels.test-support.js";

installDoublePorts();
installPanelFixture();
const agent = createAgent();

it("presses Space on the real Identity setting and commits its capabilities", async () => {
  const user = userEvent.setup();
  renderPanel();
  const identity = screen.getByRole("switch", { name: "Identity" });
  expect(identity.getAttribute("aria-checked")).toBe("false");
  identity.focus();
  await user.keyboard(" ");
  await waitFor(() => expect(double.commits).toHaveLength(1));
  expect(double.commits[0]?.draft.selectedOptional).toContain(
    "identity.federation",
  );
  expect(document.activeElement).toBe(identity);
});

it("routes an isolated agent action through the real setting's capability proposal", async () => {
  renderPanel();
  const entry = agent
    .snapshot()
    .find((item) => item.label === "Identity" && !item.offPage);
  if (!entry) throw new Error("Agent could not find Identity");
  expect(entry.actions).toContain("setChecked");
  const result = await agent.act({
    steps: [{ ref: entry.ref, action: "setChecked", args: [true] }],
  });
  expect(result.ok, result.error?.message).toBe(true);
  await waitFor(() => expect(double.commits).toHaveLength(1));
  expect(double.commits[0]?.draft.selectedOptional).toContain(
    "identity.federation",
  );
});
