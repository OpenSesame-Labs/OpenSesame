/** @vitest-environment jsdom */
import {
  resetKeymap,
  saveKeymapData,
} from "@opensesame/app-core/lib/keymap/store.js";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubScreen } from "../lib/use-narrow.test-support.js";
import { KeymapSheet } from "./KeymapSheet.js";

describe("KeymapSheet", () => {
  /** The `?` sheet shows the keys in force, never the defaults beside the overrides. */

  afterEach(() => {
    cleanup();
    resetKeymap();
  });

  function rowFor(action: string): HTMLElement | null {
    const cell = screen
      .queryAllByRole("cell")
      .find((candidate) => candidate.textContent === action);
    return cell?.closest("tr") ?? null;
  }

  function mustRow(action: string): HTMLElement {
    const found = rowFor(action);
    if (found === null) throw new Error(`no row for ${action}`);
    return found;
  }

  describe("the keyboard sheet", () => {
    it("draws the defaults as authored on an untouched keymap", () => {
      render(<KeymapSheet open close={() => {}} />);
      expect(within(mustRow("Move")).getByText("j / k or arrows")).toBeTruthy();
    });

    it("moves j from Move to Edit instead of appending a second row", () => {
      saveKeymapData({ bindings: { j: "item.edit" }, macros: {} });
      render(<KeymapSheet open close={() => {}} />);
      expect(rowFor("Move")).toBeNull();
      expect(screen.queryByText("j / k or arrows")).toBeNull();
      const edit = screen
        .getAllByRole("cell")
        .filter((cell) => cell.textContent === "Edit");
      expect(edit).toHaveLength(1);
      expect(edit[0]?.closest("tr")?.textContent).toContain("j / e");
    });

    it("follows a rebinding made while the sheet is open", () => {
      render(<KeymapSheet open close={() => {}} />);
      expect(rowFor("Move")).not.toBeNull();
      act(() => {
        saveKeymapData({ bindings: { j: "nop", k: "nop" }, macros: {} });
      });
      expect(screen.queryByText("j / k or arrows")).toBeNull();
      expect(within(mustRow("Next row")).getByText("↓")).toBeTruthy();
    });
  });
});

describe("touch", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function pointer(coarse: boolean) {
    stubScreen({ narrow: false, coarse });
  }

  describe("the help sheet", () => {
    it("lists gestures, not keys, under a finger", () => {
      pointer(true);
      render(<KeymapSheet open close={vi.fn()} />);
      expect(screen.getByRole("dialog", { name: "Gestures" })).toBeTruthy();
      expect(screen.getByText("Swipe a row left")).toBeTruthy();
      expect(screen.queryByText("Ctrl-d / u")).toBeNull();
    });

    it("lists keys with a mouse", () => {
      pointer(false);
      render(<KeymapSheet open close={vi.fn()} />);
      expect(
        screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
      ).toBeTruthy();
      expect(screen.queryByText("Swipe a row left")).toBeNull();
    });
  });
});
