/** @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import fc from "fast-check";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ConnectorModes } from "./ConnectorModes.js";

const options = [
  { id: "app", label: "GitHub App" },
  { id: "token", label: "Personal access token" },
  { id: "unavailable", label: "Unavailable", disabled: true },
] as const;
type Method = (typeof options)[number]["id"];

function Example({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<Method>("app");
  return (
    <ConnectorModes
      label="Connection method"
      value={value}
      options={options}
      disabled={disabled}
      onChange={setValue}
    />
  );
}

afterEach(cleanup);

it("keeps one named tab stop and moves selection with the arrow keys", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const group = screen.getByRole("radiogroup", { name: "Connection method" });
  const app = screen.getByRole("radio", { name: "GitHub App" });
  const token = screen.getByRole("radio", { name: "Personal access token" });
  expect(group).toBeTruthy();
  expect(app.getAttribute("aria-disabled")).toBeNull();
  expect([app, token].filter((item) => item.tabIndex === 0)).toEqual([app]);
  await user.tab();
  expect(document.activeElement).toBe(app);
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(token);
  expect(token.getAttribute("aria-checked")).toBe("true");
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(app);
  expect(app.getAttribute("aria-checked")).toBe("true");
  await user.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(token);
  expect(token.getAttribute("aria-checked")).toBe("true");
});

it("lets an SDK agent discover and change the named method", async () => {
  const agent = createAgent();
  render(<Example />);
  const entry = agent
    .snapshot()
    .find((item) => item.label === "Connection method" && !item.offPage);
  expect(entry).toBeDefined();
  expect(entry?.actions).toContain("setValue");
  const result = await agent.act({
    steps: [{ ref: entry?.ref ?? "", action: "setValue", args: ["token"] }],
  });
  expect(result.ok, result.error?.message).toBe(true);
  await waitFor(() =>
    expect(
      screen
        .getByRole("radio", { name: "Personal access token" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

it("refuses agent selection when the group or choice is disabled", async () => {
  const agent = createAgent();
  const view = render(<Example />);
  const entry = agent
    .snapshot()
    .find((item) => item.label === "Connection method" && !item.offPage);
  if (!entry) throw new Error("Agent could not find the chooser");
  await agent.act({
    steps: [{ ref: entry.ref, action: "setValue", args: ["unavailable"] }],
  });
  expect(
    screen.getByRole("radio", { name: "GitHub App", checked: true }),
  ).toBeTruthy();
  view.rerender(<Example disabled />);
  await agent.act({
    steps: [{ ref: entry.ref, action: "setValue", args: ["token"] }],
  });
  expect(
    screen.getByRole("radio", { name: "GitHub App", checked: true }),
  ).toBeTruthy();
});

it("matches the selection and lock model across generated interaction sequences", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.constantFrom<Method | "toggle">(
          "app",
          "token",
          "unavailable",
          "toggle",
        ),
        {
          minLength: 1,
          maxLength: 20,
        },
      ),
      async (actions) => {
        const view = render(<Example />);
        let expected: Method = "app";
        let locked = false;
        try {
          for (const action of actions) {
            if (action === "toggle") {
              locked = !locked;
              view.rerender(<Example disabled={locked} />);
            } else {
              const option = options.find((item) => item.id === action);
              if (!option) throw new Error("Unknown test option");
              fireEvent.click(
                screen.getByRole("radio", { name: option.label }),
              );
              if (!locked && action !== "unavailable") expected = action;
            }
            const selected = options.filter(
              (item) =>
                screen
                  .getByRole("radio", { name: item.label })
                  .getAttribute("aria-checked") === "true",
            );
            expect(selected.map((item) => item.id)).toEqual([expected]);
          }
        } finally {
          view.unmount();
        }
      },
    ),
    { seed: 20261116, numRuns: 50 },
  );
});
