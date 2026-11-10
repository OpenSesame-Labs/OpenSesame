/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportSourceSheet } from "./ImportSourceSheet.js";

afterEach(cleanup);

describe("the guided import source stage", () => {
  it("leads with browsers, shows the chosen source's own export steps, and states the plaintext risk", async () => {
    const user = userEvent.setup();
    render(<ImportSourceSheet onPick={vi.fn()} onClose={vi.fn()} />);
    expect(
      screen.getByRole("dialog", { name: "Import passwords" }),
    ).toBeTruthy();
    // Chrome is the default first-run source, with Chrome's own steps.
    expect(screen.getByText(/Chrome: Settings/)).toBeTruthy();
    // The tiles are a labelled group of toggles; the chosen one is pressed.
    const group = screen.getByRole("group", { name: "Source" });
    expect(group.querySelector('[aria-pressed="true"]')?.textContent).toContain(
      "Chrome",
    );
    await user.click(screen.getByRole("button", { name: "Firefox" }));
    expect(screen.getByText(/Firefox → Passwords/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Firefox" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // The honest limits ride along: no silent browser reading, and the
    // exported file itself is the risk to clean up.
    expect(screen.getByText(/cannot read your browser itself/)).toBeTruthy();
    expect(screen.getByText(/Delete it once the import finishes/)).toBeTruthy();
  });

  it("hands over to the picker only from the explicit key", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<ImportSourceSheet onPick={onPick} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Bitwarden/ }));
    expect(onPick).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Choose the exported file" }),
    );
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
