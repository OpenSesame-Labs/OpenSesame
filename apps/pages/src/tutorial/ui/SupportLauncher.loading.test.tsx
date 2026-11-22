import { fireEvent, render, screen, within } from "@testing-library/react";
/** @vitest-environment jsdom */
import { Suspense, useState } from "react";
import { describe, expect, it } from "vitest";
import { SupportPanelFallback } from "./SupportLauncher.js";

const pending = new Promise<never>(() => {});

function PendingPanel(): never {
  throw pending;
}

function LoadingHarness() {
  const [open, setOpen] = useState(true);
  return open ? (
    <Suspense fallback={<SupportPanelFallback close={() => setOpen(false)} />}>
      <PendingPanel />
    </Suspense>
  ) : null;
}

describe("SupportPanelFallback", () => {
  it("owns focus and immediate Escape while the lazy panel is unresolved", () => {
    render(<LoadingHarness />);
    const dialog = screen.getByRole("dialog", { name: "Support" });
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull();
  });
});
