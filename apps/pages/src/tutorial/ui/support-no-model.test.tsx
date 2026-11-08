import { clearNotices } from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import {
  fakeAgentAlwaysUnavailable,
} from "@opensesame/support-agent";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  mount,
  openPanel,
  resetSupport,
  showQuestions,
} from "./support-test-harness.js";

afterEach(() => {
  resetSupport();
  clearNotices();
});

describe("support with nothing to answer", () => {
  it("still opens and helps when nothing can answer", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);
    await showQuestions(user);

    // No sentence narrating why nothing can answer: the written help below is
    // the answer, and the field says what it now does.
    expect(screen.queryByText(/no on-device model/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Where do I lock the vault?" }),
    ).toBeTruthy();
    const field = await screen.findByLabelText<HTMLInputElement>(
      "Search the written help",
    );
    expect(field.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("answers an authored topic with no model at all", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);
    await showQuestions(user);
    await user.click(
      await screen.findByRole("button", { name: "Where do I lock the vault?" }),
    );

    expect(
      await screen.findByText(/Locking drops the vault keys held in memory/),
    ).toBeTruthy();
  });

  it("searches the written help without asking anything", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);
    await showQuestions(user);

    // With no model the one field searches the checked-in help rather than
    // asking, live as you type, and says so on the button.
    const field = await screen.findByLabelText<HTMLInputElement>(
      "Search the written help",
    );
    await user.type(field, "healthy");
    expect(
      await screen.findByRole("button", {
        name: "How do I tell whether OpenSesame is healthy?",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Where do I lock the vault?" }),
    ).toBeNull();
  });
});
