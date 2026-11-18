/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import fc from "fast-check";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CapabilitySwitch } from "./CapabilitySwitch.js";

const agent = createAgent();

function Example({
  disabled = false,
  allow = true,
  onRequest,
}: {
  disabled?: boolean;
  allow?: boolean;
  onRequest: () => void;
}) {
  const [on, setOn] = useState(false);
  return (
    <fieldset disabled={disabled}>
      <CapabilitySwitch
        label="Example capability"
        capabilityTitle="Example"
        on={on}
        onToggle={() => {
          onRequest();
          if (allow) setOn((current) => !current);
        }}
      />
    </fieldset>
  );
}

afterEach(cleanup);

it("keeps its accessible name, focus, and one request per Space or Enter", async () => {
  const onRequest = vi.fn();
  const user = userEvent.setup();
  render(<Example onRequest={onRequest} />);
  const control = screen.getByRole("switch", { name: "Example capability" });
  expect(control.getAttribute("data-capability-title")).toBe("Example");
  expect(control.getAttribute("aria-checked")).toBe("false");
  await user.tab();
  expect(document.activeElement).toBe(control);
  await user.keyboard(" ");
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(onRequest).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(control);
  await user.keyboard("{Enter}");
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(onRequest).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(control);
});

it("exposes the named SDK action without bypassing the application's decision", async () => {
  const onRequest = vi.fn();
  const view = render(<Example allow={false} onRequest={onRequest} />);
  const entry = agent
    .snapshot()
    .find((item) => item.label === "Example capability" && !item.offPage);
  if (!entry) throw new Error("Agent could not find the switch");
  expect(entry.actions).toContain("setChecked");
  expect(
    (
      await agent.act({
        steps: [{ ref: entry.ref, action: "setChecked", args: [false] }],
      })
    ).ok,
  ).toBe(true);
  expect(onRequest).not.toHaveBeenCalled();
  const step = {
    steps: [{ ref: entry.ref, action: "setChecked", args: [true] }],
  };
  expect((await agent.act(step)).ok).toBe(true);
  expect(onRequest).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("switch", { name: "Example capability", checked: false }),
  ).toBeTruthy();
  view.rerender(<Example onRequest={onRequest} />);
  expect((await agent.act(step)).ok).toBe(true);
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Example capability", checked: true }),
    ).toBeTruthy(),
  );
  expect(onRequest).toHaveBeenCalledTimes(2);
});

it("does not let an agent activate a switch inside a disabled fieldset", async () => {
  const onRequest = vi.fn();
  render(<Example disabled onRequest={onRequest} />);
  const entry = agent
    .snapshot()
    .find((item) => item.label === "Example capability" && !item.offPage);
  if (!entry) throw new Error("Agent could not find the switch");
  await agent.act({
    steps: [{ ref: entry.ref, action: "setChecked", args: [true] }],
  });
  expect(onRequest).not.toHaveBeenCalled();
  expect(
    screen.getByRole("switch", { name: "Example capability", checked: false }),
  ).toBeTruthy();
});

it("matches controlled and disabled behavior over generated interactions", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("click", "disable", "allow"), {
        minLength: 1,
        maxLength: 16,
      }),
      async (actions) => {
        const onRequest = vi.fn();
        const user = userEvent.setup();
        let disabled = false;
        let allow = true;
        let expected = false;
        let requests = 0;
        const view = render(<Example onRequest={onRequest} />);
        try {
          for (const action of actions) {
            if (action === "disable") disabled = !disabled;
            if (action === "allow") allow = !allow;
            if (action === "click") {
              await user.click(
                screen.getByRole("switch", { name: "Example capability" }),
              );
              requests += Number(!disabled);
              if (!disabled && allow) expected = !expected;
            } else {
              view.rerender(
                <Example
                  disabled={disabled}
                  allow={allow}
                  onRequest={onRequest}
                />,
              );
            }
            expect(onRequest).toHaveBeenCalledTimes(requests);
            expect(
              screen
                .getByRole("switch", { name: "Example capability" })
                .getAttribute("aria-checked"),
            ).toBe(String(expected));
          }
        } finally {
          view.unmount();
        }
      },
    ),
    { seed: 20261116, numRuns: 40 },
  );
});
