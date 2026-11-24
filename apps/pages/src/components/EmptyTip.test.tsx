/** @vitest-environment jsdom */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchMediaFor } from "../lib/use-narrow.test-fake.js";
import {
  EmptyTip,
  type EmptyTipKey,
  emptyTipKeys,
  emptyTips,
  isEmptyTipKey,
  touchTips,
} from "./EmptyTip.js";

describe("EmptyTip", () => {
  const KEYS = emptyTipKeys;

  describe("EmptyTip", () => {
    afterEach(cleanup);

    it("renders IconInfo guidance with role=note", () => {
      render(<EmptyTip>Press x to explode.</EmptyTip>);
      const tip = screen.getByRole("note");
      expect(tip.textContent).toContain("Press x to explode.");
      expect(tip.className).toContain("empty__tip--keys");
      expect(tip.querySelector("svg")).not.toBeNull();
    });

    it("carries both voices where the call site names a tip", () => {
      // Hidden whole on a phone, a keyboard tip left the empty state bare.
      render(<EmptyTip tip="rail" />);
      const tip = screen.getByRole("note");
      expect(tip.className).toBe("empty__tip");
      expect(tip.querySelector(".empty__tip-keys")?.textContent).toBe(
        emptyTips.rail,
      );
      expect(tip.querySelector(".empty__tip-touch")?.textContent).toBe(
        "The menu key at the top opens every section.",
      );
    });

    it("gives every keyboard tip the finger's own voice", () => {
      // A tip that names a key and has no twin is hidden outright on a phone.
      expect(Object.keys(touchTips).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        render(<EmptyTip tip={key} />);
        const note = screen.getByRole("note");
        expect(note.querySelector(".empty__tip-keys")?.textContent).toBe(
          emptyTips[key],
        );
        const touch =
          note.querySelector(".empty__tip-touch")?.textContent ?? "";
        expect(touch).not.toBe("");
        expect(touch).not.toMatch(/\b(esc|enter|press|keyboard|j\/k)\b/i);
        cleanup();
      }
    });

    it("swaps the help and back tips for the gesture that does the same", () => {
      render(<EmptyTip tip="escBack" />);
      expect(document.querySelector(".empty__tip-touch")?.textContent).toBe(
        "Swipe right to go back.",
      );
      cleanup();
      render(<EmptyTip tip="keymap" />);
      expect(document.querySelector(".empty__tip-touch")?.textContent).toBe(
        "Gestures in the ⋯ menu lists every gesture.",
      );
    });

    it("can drop the keys class for non-keyboard tips", () => {
      render(<EmptyTip keys={false}>Add a connector first.</EmptyTip>);
      expect(screen.getByRole("note").className).toBe("empty__tip");
    });
  });
});

describe("callsites", () => {
  const SRC = join(import.meta.dirname, "..");

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((f) => f.isFile() && /\.tsx$/.test(f.name))
      .filter((f) => !/\.test\.tsx$/.test(f.name))
      .map((f) => join(f.parentPath, f.name));
  }

  /** Every `<EmptyTip …>` opening tag in the app, with the file it is in. */
  type CallSite = { file: string; tag: string };

  function callSites(): CallSite[] {
    const found: CallSite[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/<EmptyTip\b[^>]*?\/?>/gs)) {
        found.push({ file, tag: m[0] });
      }
    }
    return found;
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("every EmptyTip call site, under a finger", () => {
    it("names its tip or says it is not about keys", () => {
      // A tip handed as children is matched by nothing: it would be keys-only
      // and vanish on a phone with no word to say in its place.
      const sites = callSites();
      expect(sites.length).toBeGreaterThan(0);
      for (const { file, tag } of sites) {
        expect(tag, file).toMatch(/\btip=|\bkeys=\{false\}/);
      }
    });

    it("draws a touch voice for each tip a call site names", () => {
      vi.stubGlobal("matchMedia", matchMediaFor(true));
      const named = new Set<EmptyTipKey>();
      for (const { tag } of callSites()) {
        for (const m of tag.matchAll(/"([A-Za-z]+)"/g)) {
          const key = m[1];
          if (key !== undefined && isEmptyTipKey(key)) named.add(key);
        }
      }
      expect(named.size).toBeGreaterThanOrEqual(5);
      for (const key of named) {
        render(<EmptyTip tip={key} />);
        const note = screen.getByRole("note");
        // Never the keys-only class, which CSS hides under a coarse pointer.
        expect(note.className).not.toContain("empty__tip--keys");
        expect(
          note.querySelector(".empty__tip-touch")?.textContent?.length,
          key,
        ).toBeGreaterThan(0);
        cleanup();
      }
    });
  });
});
