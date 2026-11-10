/** @vitest-environment jsdom */
import {
  guidanceSeams,
  loadGuidance,
  rememberTourAnswered,
} from "@opensesame/app-core/lib/guidance.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupportContext } from "../../tutorial/support-context.js";
import { stubSupportController } from "../../tutorial/support-controller.test-support.js";
import { GuidedToursRow } from "./GuidedToursRow.js";

const original = { ...guidanceSeams };
let stored: string | null = null;

beforeEach(() => {
  stored = null;
  guidanceSeams.read = () => stored;
  guidanceSeams.write = (value) => {
    stored = value;
  };
});
afterEach(() => {
  cleanup();
  Object.assign(guidanceSeams, original);
});

function row() {
  const stub = stubSupportController("/settings");
  render(
    <SupportContext.Provider value={stub.support}>
      <GuidedToursRow />
    </SupportContext.Provider>,
  );
  return stub;
}

describe("Settings › Guided tours", () => {
  it("draws nothing without a support provider", () => {
    const { container } = render(<GuidedToursRow />);
    expect(container.firstChild).toBeNull();
  });

  it("opens the tutorial library", () => {
    const { opened } = row();
    fireEvent.click(screen.getByRole("button", { name: "Open guided tours" }));
    expect(opened).toEqual(["tutorials"]);
  });

  it("offers by default and stores the mode a person chooses", () => {
    row();
    const select = screen.getByLabelText<HTMLSelectElement>(
      "On a screen you have not seen",
    );
    expect(select.value).toBe("offer");
    fireEvent.change(select, { target: { value: "auto" } });
    expect(loadGuidance().mode).toBe("auto");
    fireEvent.change(select, { target: { value: "off" } });
    expect(loadGuidance().mode).toBe("off");
  });

  it("offers everything again only when something was answered", () => {
    row();
    expect(
      screen.queryByRole("button", {
        name: "Offer tours and recommendations again",
      }),
    ).toBeNull();
    cleanup();
    rememberTourAnswered("vault.lock");
    row();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Offer tours and recommendations again",
      }),
    );
    expect(loadGuidance().tours).toEqual([]);
  });
});
