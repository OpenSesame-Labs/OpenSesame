/** @vitest-environment jsdom */
import { resetContributionsForTest } from "@opensesame/app-core/lib/contributions.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FirstItemOffer,
  type PasswordTypesState,
  firstItemOfferSeams,
  passwordTypesMissing,
} from "./FirstItemOffer.js";

/** The item types: shipped and permitted here, and not yet switched on. */
const OFF: PasswordTypesState = {
  distributed: true,
  permitted: true,
  approved: false,
};

const original = { ...firstItemOfferSeams };
let types: PasswordTypesState | undefined = OFF;

function offer(listedCount = 0) {
  return render(
    <MemoryRouter>
      <FirstItemOffer
        createPath="/vault/new"
        listedCount={listedCount}
        inTrash={false}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  types = OFF;
  firstItemOfferSeams.usePasswordTypes = () => types;
  firstItemOfferSeams.accountCreatable = () => false;
});
afterEach(() => {
  cleanup();
  resetContributionsForTest();
  Object.assign(firstItemOfferSeams, original);
});

describe("an empty vault with no password type (ADR 0221)", () => {
  it("says why there are no passwords and offers the switch first", () => {
    offer();
    expect(screen.getByText(/plain secrets and files only/)).toBeTruthy();
    const turnOn = screen.getByRole("button", {
      name: "Turn on passwords, cards and notes",
    });
    expect(turnOn.className).toContain("btn--primary");
    // The guided first password describes fields this vault does not have yet.
    expect(screen.queryByText(/Add your first password/)).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Add a plain secret instead" })
        .getAttribute("href"),
    ).toBe("/vault/new");
  });

  it("commits the item types on one press", async () => {
    const turnOn = vi.fn(() => Promise.resolve(null));
    firstItemOfferSeams.turnOnPasswordTypes = turnOn;
    offer();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Turn on passwords, cards and notes",
      }),
    );
    expect(turnOn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Turn on passwords, cards and notes" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });

  it("offers the guided first password once the types are on", () => {
    types = { ...OFF, approved: true };
    offer();
    expect(screen.getByText(/Add your first password/)).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Turn on passwords, cards and notes",
      }),
    ).toBeNull();
  });

  it("does not claim there are no passwords when the Account pack is on", () => {
    // Item types as a whole are off, but Account was switched on by itself.
    firstItemOfferSeams.accountCreatable = () => true;
    offer();
    expect(screen.getByText(/Add your first password/)).toBeTruthy();
    expect(screen.queryByText(/plain secrets and files only/)).toBeNull();
  });

  it("is gone with the first sealed item", () => {
    const { container } = offer(1);
    expect(container.firstChild).toBeNull();
  });
});

describe("whether the switch can be offered", () => {
  it("needs the types shipped, permitted and off", () => {
    expect(passwordTypesMissing(OFF)).toBe(true);
    expect(passwordTypesMissing({ ...OFF, approved: true })).toBe(false);
    expect(passwordTypesMissing({ ...OFF, distributed: false })).toBe(false);
    expect(passwordTypesMissing({ ...OFF, permitted: false })).toBe(false);
  });

  it("is not offered before a plan has resolved", () => {
    expect(passwordTypesMissing(undefined)).toBe(false);
  });
});
