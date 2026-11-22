import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIPBOARD_READ_NOTICE,
  clearCopiedSecret,
  useCopySecret,
  useSessionGuards,
} from "./hooks.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushClipboard() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

type ClipboardStub = {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
};

function stubClipboard(overrides: Partial<ClipboardStub> = {}): ClipboardStub {
  const clipboard: ClipboardStub = {
    readText: vi.fn().mockResolvedValue(""),
    writeText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  Object.defineProperty(navigator, "permissions", {
    value: {
      query: vi.fn().mockResolvedValue({ state: "granted" }),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  return clipboard;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("clipboard lifecycle races", () => {
  it("keeps a newer identical copy tracked when an old read finishes", async () => {
    const oldRead = deferred<string>();
    let contents = "";
    const clipboard = stubClipboard({
      readText: vi.fn().mockImplementation(async () => contents),
      writeText: vi.fn().mockImplementation(async (value: string) => {
        contents = value;
      }),
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 0 }));
    const { result } = renderHook(() => useCopySecret());
    await expect(result.current("same-secret")).resolves.toBe("copied");
    contents = "replaced externally";
    clipboard.readText.mockImplementationOnce(() => oldRead.promise);

    clearCopiedSecret();
    await flushClipboard();
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    await expect(result.current("same-secret")).resolves.toBe("copied");
    oldRead.resolve("replaced externally");
    await flushClipboard();
    expect(contents).toBe("same-secret");

    clearCopiedSecret();
    await flushClipboard();
    expect(contents).toBe("");
  });

  it("does not let a stale permission check erase a newer copy", async () => {
    const oldPermission = deferred<{ state: string }>();
    let contents = "";
    const clipboard = stubClipboard({
      writeText: vi.fn().mockImplementation(async (value: string) => {
        contents = value;
      }),
    });
    Object.defineProperty(navigator, "permissions", {
      value: {
        query: vi
          .fn()
          .mockReturnValueOnce(oldPermission.promise)
          .mockResolvedValue({ state: "prompt" }),
      },
      configurable: true,
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 0 }));
    const { result } = renderHook(() => useCopySecret());
    await result.current("old-secret");
    clearCopiedSecret();
    await expect(result.current("new-secret")).resolves.toBe("copied");
    oldPermission.resolve({ state: "prompt" });
    await flushClipboard();
    expect(contents).toBe("new-secret");
    expect(clipboard.readText).not.toHaveBeenCalled();

    clearCopiedSecret();
    await flushClipboard();
    expect(contents).toBe("");
  });

  it("prevents a late write and its cleanup from erasing a newer copy", async () => {
    const firstWrite = deferred<void>();
    const oldPermission = deferred<{ state: string }>();
    let contents = "";
    const clipboard = stubClipboard({
      writeText: vi.fn().mockImplementation(async (value: string) => {
        if (value === "old-secret") await firstWrite.promise;
        contents = value;
      }),
    });
    Object.defineProperty(navigator, "permissions", {
      value: {
        query: vi
          .fn()
          .mockReturnValueOnce(oldPermission.promise)
          .mockResolvedValue({ state: "prompt" }),
      },
      configurable: true,
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 0 }));
    const { result } = renderHook(() => useCopySecret());
    const lateCopy = result.current("old-secret");
    clearCopiedSecret();
    await expect(result.current("new-secret")).resolves.toBe("unavailable");
    expect(clipboard.writeText).not.toHaveBeenCalledWith("new-secret");

    firstWrite.resolve();
    await flushClipboard();
    expect(contents).toBe("old-secret");
    await expect(result.current("new-secret")).resolves.toBe("copied");
    oldPermission.resolve({ state: "prompt" });
    await expect(lateCopy).resolves.toBe("unavailable");
    expect(contents).toBe("new-secret");

    clearCopiedSecret();
    await flushClipboard();
    expect(contents).toBe("");
  });

  it("does not start a copy while a clipboard clear write is pending", async () => {
    const clearWrite = deferred<void>();
    let contents = "";
    const clipboard = stubClipboard({
      writeText: vi.fn().mockImplementation(async (value: string) => {
        if (value === "") await clearWrite.promise;
        contents = value;
      }),
    });
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      configurable: true,
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 0 }));
    const { result } = renderHook(() => useCopySecret());
    await result.current("old-secret");
    clearCopiedSecret();
    await flushClipboard();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
    await expect(result.current("new-secret")).resolves.toBe("unavailable");
    expect(clipboard.writeText).not.toHaveBeenCalledWith("new-secret");
    clearWrite.resolve();
    await flushClipboard();
    await expect(result.current("new-secret")).resolves.toBe("copied");
    expect(contents).toBe("new-secret");
    clearCopiedSecret();
    await flushClipboard();
  });

  it("still clears the old copy if a newer write fails during lock", async () => {
    const newWrite = deferred<void>();
    let contents = "";
    const clipboard = stubClipboard({
      writeText: vi.fn().mockImplementation(async (value: string) => {
        if (value === "new-secret") await newWrite.promise;
        contents = value;
      }),
    });
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      configurable: true,
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 0 }));
    const { result } = renderHook(() => useCopySecret());
    await result.current("old-secret");
    const failedCopy = result.current("new-secret");
    clearCopiedSecret();
    await flushClipboard();
    expect(contents).toBe("old-secret");
    expect(clipboard.writeText).not.toHaveBeenCalledWith("");
    newWrite.reject(new Error("denied"));
    await expect(failedCopy).resolves.toBe("unavailable");
    await flushClipboard();
    expect(contents).toBe("");
  });

  it("keeps the clipboard notice through lock and overlapping reads", async () => {
    const firstRead = deferred<string>();
    const secondRead = deferred<string>();
    const clipboard = stubClipboard({
      readText: vi
        .fn()
        .mockReturnValueOnce(firstRead.promise)
        .mockReturnValueOnce(secondRead.promise),
    });
    act(() => vaultStore.setPrefs({ clipboardClearSeconds: 0 }));
    const { result } = renderHook(() => {
      useSessionGuards();
      return useCopySecret();
    });
    const hasNotice = () =>
      listNotices().some((notice) => notice.id === CLIPBOARD_READ_NOTICE.id);
    await result.current("secret");
    clearCopiedSecret();
    await flushClipboard();
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(hasNotice()).toBe(true);

    act(() => vaultStore.lock());
    expect(hasNotice()).toBe(true);
    await flushClipboard();
    expect(clipboard.readText).toHaveBeenCalledTimes(2);
    secondRead.resolve("a newer external value");
    await flushClipboard();
    expect(hasNotice()).toBe(true);
    firstRead.resolve("a newer external value");
    await flushClipboard();
    expect(hasNotice()).toBe(false);
  });
});
