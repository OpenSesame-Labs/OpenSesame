/** @vitest-environment jsdom */
import type { Notice } from "@opensesame/app-core/lib/notices.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusNoticeCard } from "./NotificationsBar.js";

afterEach(() => cleanup());

const asked: Notice = {
  id: "recommend.security-checks",
  kind: "status",
  tone: "info",
  title: "Check passwords against known breaches",
  body: "Only five characters of a hash leave this device.",
  open: {
    to: "/settings/features#feature-security-checks",
    label: "Turn on breach checks",
  },
  act: { label: "Turn on breach checks", worded: true, run: () => {} },
  createdAt: "2026-11-10T00:00:00Z",
};

/** The same notice once its act has run in place: the outcome, no act. */
const answered: Notice = {
  ...asked,
  title: "Breach checks is on",
  body: "It can be switched off again in Settings, under Features.",
  open: {
    to: "/settings/features#feature-security-checks",
    label: "Open Breach checks settings",
  },
  act: undefined,
};

/** The act's own key: the second of the two that carry its label. */
function actKey(label: string): HTMLElement {
  const key = screen.getAllByRole("button", { name: label })[1];
  if (key === undefined) throw new Error(`no act key named ${label}`);
  return key;
}

function card(notice: Notice, onOpen = vi.fn()) {
  return (
    <MemoryRouter>
      <StatusNoticeCard notice={notice} onOpen={onOpen} />
    </MemoryRouter>
  );
}

describe("a tray card whose act works in place (ADR 0221)", () => {
  it("hands focus to the key the card still has once its act is answered", () => {
    const view = render(card(asked));
    // Two keys share the label on the asked card: the route and the act.
    const act = actKey("Turn on breach checks");
    act.focus();
    fireEvent.click(act);
    // The outcome replaces the card; the pressed key goes with it.
    view.rerender(card(answered));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open Breach checks settings" }),
    );
  });

  it("moves nothing when the act was not pressed from the keyboard", () => {
    const view = render(card(asked));
    fireEvent.click(actKey("Turn on breach checks"));
    view.rerender(card(answered));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus to the page for an act that opens it", () => {
    const onOpen = vi.fn();
    const opens: Notice = {
      ...asked,
      act: { label: "Set up backups", opens: true, run: () => {} },
    };
    const view = render(card(opens, onOpen));
    const key = screen.getByRole("button", { name: "Set up backups" });
    key.focus();
    fireEvent.click(key);
    expect(onOpen).toHaveBeenCalledTimes(1);
    view.rerender(card(answered));
    expect(document.activeElement).toBe(document.body);
  });
});
