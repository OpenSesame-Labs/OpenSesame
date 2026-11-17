import { reportClaim } from "@opensesame/app-core/lib/claims/route-model.js";
import {
  clearNotices,
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeCorner } from "./NoticeCorner.js";

afterEach(() => {
  clearNotices();
  cleanup();
});

describe("ClaimDropAnnouncement", () => {
  it("shows the latest claim in an in-flow alert while retaining the earlier notice", () => {
    render(
      <MemoryRouter>
        <NoticeCorner />
      </MemoryRouter>,
    );
    act(() => {
      reportClaim("First.");
      reportClaim("Second.");
    });
    const alert = screen.getByRole("alert", { name: "Urgent notifications" });
    expect(alert.textContent).toContain("Second.");
    expect(alert.textContent).not.toContain("First.");
    expect(listNotices()).toHaveLength(2);
  });

  it("clears when the claim notice is dismissed from the tray", () => {
    render(
      <MemoryRouter>
        <NoticeCorner />
      </MemoryRouter>,
    );
    act(() => {
      reportClaim("Refused.");
    });
    expect(
      screen.getByRole("alert", { name: "Urgent notifications" }).textContent,
    ).toContain("Refused.");
    const id = listNotices().find((n) => n.body === "Refused.")?.id;
    expect(id).toBeTruthy();
    act(() => dismissNotice(id ?? ""));
    expect(
      screen.getByRole("alert", { name: "Urgent notifications" }).textContent,
    ).toBe("");
  });
});
