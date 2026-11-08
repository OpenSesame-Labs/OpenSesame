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
    await user.click(screen.getByRole("button", { name: "Firefox" }));
    expect(screen.getByText(/Firefox → Passwords/)).toBeTruthy();
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
