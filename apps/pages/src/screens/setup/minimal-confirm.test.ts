/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { describe, expect, it, vi } from "vitest";
import {
  KEEP_DEFAULT_SETUP,
  USE_MINIMAL_ANYWAY,
  showMinimalConfirm,
} from "./minimal-confirm.js";

describe("showMinimalConfirm", () => {
  it("Keep Default runs the default commit callback", () => {
    const minimal = vi.fn();
    const keepDefault = vi.fn();
    showMinimalConfirm(minimal, keepDefault);
    const notice = listNotices().find((n) => n.id === "setup.minimal.confirm");
    notice?.alt?.run();
    expect(minimal).not.toHaveBeenCalled();
    expect(keepDefault).toHaveBeenCalledOnce();
    clearNotices();
  });

  it("Use Minimal anyway runs the minimal commit callback", () => {
    const minimal = vi.fn();
    const keepDefault = vi.fn();
    showMinimalConfirm(minimal, keepDefault);
    const notice = listNotices().find((n) => n.id === "setup.minimal.confirm");
    notice?.act?.run();
    expect(minimal).toHaveBeenCalledOnce();
    expect(keepDefault).not.toHaveBeenCalled();
    clearNotices();
  });

  it("exposes the expected worded keys", () => {
    showMinimalConfirm(() => {}, () => {});
    const notice = listNotices().find((n) => n.id === "setup.minimal.confirm");
    expect(notice?.act?.label).toBe(USE_MINIMAL_ANYWAY);
    expect(notice?.alt?.label).toBe(KEEP_DEFAULT_SETUP);
    clearNotices();
  });
});