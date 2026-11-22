/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCopiedSecret, useCopySecret } from "./hooks.js";

type ClipboardStub = {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
};
function stubClipboard(overrides: Partial<ClipboardStub> = {}): ClipboardStub {
  const clipboard = {
    readText: vi.fn().mockResolvedValue(""),
    writeText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  Object.defineProperty(navigator, "permissions", {
    value: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
    configurable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  return clipboard;
}
afterEach(() => {
  cleanup();
  clearNotices();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sensitive clipboard races", () => {
  it("finishes a copy begun before lock by attempting to clear that value", async () => {
    let finishWrite: (() => void) | undefined;
    const clipboard = stubClipboard({
      readText: vi.fn().mockResolvedValue("pending-secret"),
      writeText: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishWrite = resolve;
            }),
        )
        .mockResolvedValue(undefined),
    });
    const { result } = renderHook(() => useCopySecret());
    const copy = result.current("pending-secret");
    clearCopiedSecret();
    await act(async () => {
      finishWrite?.();
      await expect(copy).resolves.toBe("unavailable");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("keeps a newer copy when the previous clear's read completes", async () => {
    let finishRead: ((value: string) => void) | undefined;
    const clipboard = stubClipboard({
      readText: vi.fn().mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            finishRead = resolve;
          }),
      ),
    });
    const { result } = renderHook(() => useCopySecret());
    await result.current("first");
    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
    });
    await expect(result.current("second")).resolves.toBe("copied");
    await act(async () => {
      finishRead?.("first");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("second");
    clipboard.readText.mockResolvedValue("second");
    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("preserves the previous clear deadline if a second copy is denied", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard({
      readText: vi.fn().mockResolvedValue("first"),
      writeText: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("denied"))
        .mockResolvedValue(undefined),
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 10 }));
    const { result } = renderHook(() => useCopySecret());
    await result.current("first");
    vi.advanceTimersByTime(5_000);
    await expect(result.current("second")).resolves.toBe("unavailable");
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("retries as a lock clear if locking occurs during a denied timed read", async () => {
    vi.useFakeTimers();
    let rejectRead: ((error: Error) => void) | undefined;
    const clipboard = stubClipboard({
      readText: vi.fn().mockImplementation(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectRead = reject;
          }),
      ),
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 10 }));
    const { result } = renderHook(() => useCopySecret());
    await result.current("first");
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    clearCopiedSecret();
    // Both reads fail, so lock falls back to writing an empty clipboard.
    clipboard.readText.mockRejectedValue(new Error("denied"));
    await act(async () => {
      rejectRead?.(new Error("denied"));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("warns when a timed read fails and retains the copy for a lock attempt", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard({
      readText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 10 }));
    const { result } = renderHook(() => useCopySecret());
    await result.current("secret");
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).not.toHaveBeenCalledWith("");
    expect(
      listNotices().some((notice) => notice.id === "clipboard-clear-failed"),
    ).toBe(true);
    clearCopiedSecret();
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
    expect(
      listNotices().some((notice) => notice.id === "clipboard-clear-failed"),
    ).toBe(false);
  });
});
