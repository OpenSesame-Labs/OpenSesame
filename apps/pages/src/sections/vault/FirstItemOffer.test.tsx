/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { FirstItemOffer } from "./FirstItemOffer.js";

afterEach(() => {
  cleanup();
});

describe("the empty-vault first-run offer", () => {
  it("keeps the guided import sheet mounted after items land", () => {
    // Codex review on PR #2551: the offer unmounted as soon as the vault
    // had an item — which a successful import itself causes — taking the
    // import sheet's completion screen with it. The trigger key is what
    // goes away; the flow stays until the person closes it.
    const offer = (listedCount: number) => (
      <MemoryRouter>
        <FirstItemOffer
          createPath="/vault/new"
          listedCount={listedCount}
          inTrash={false}
        />
      </MemoryRouter>
    );
    const { rerender } = render(offer(0));

    fireEvent.click(
      screen.getByRole("button", { name: "Import passwords instead" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Import passwords" }),
    ).toBeTruthy();

    rerender(offer(3));

    expect(
      screen.getByRole("dialog", { name: "Import passwords" }),
    ).toBeTruthy();
    expect(screen.queryByText("Add your first password")).toBeNull();
    const trigger = screen.getByText("Import passwords instead");
    expect(trigger.hidden).toBe(true);
  });

  it("stands down its keys in the trash without offering a first item", () => {
    render(
      <MemoryRouter>
        <FirstItemOffer createPath="/vault/new" listedCount={0} inTrash />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Add your first password")).toBeNull();
    expect(screen.getByText("Import passwords instead").hidden).toBe(true);
  });
});
