/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { type Host, configureHost, host } from "@opensesame/app-core/host.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { ImportKey } from "./ImportKey.js";

type WorkerReply = { hash: ArrayBuffer } | null;

class HangingWorker {
  static instances: HangingWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    HangingWorker.instances.push(this);
  }
}

const fixture = readFileSync(
  fileURLToPath(
    new NodeURL(
      "../../../../../../tests/fixtures/kdbx/roundtrip.kdbx",
      import.meta.url,
    ),
  ),
);
let previousHost: Host;
const previousHooks = { ...vaultHooksSeams };
const wakeLockDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "wakeLock",
);

beforeEach(() => {
  HangingWorker.instances = [];
  clearNotices();
  previousHost = host();
  configureHost({ ...previousHost, worker: overlapCast(HangingWorker) });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ items: [], folders: [] }),
    useVaultStore: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  clearNotices();
  configureHost(previousHost);
  Object.assign(vaultHooksSeams, previousHooks);
  if (wakeLockDescriptor)
    Object.defineProperty(navigator, "wakeLock", wakeLockDescriptor);
  else Reflect.deleteProperty(navigator, "wakeLock");
  vi.restoreAllMocks();
});

function pick(bytes: Uint8Array) {
  const file = new File(["kdbx"], "fixture.kdbx", {
    type: "application/octet-stream",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new Uint8Array(bytes).buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose a file to import"), {
    target: { files: [file] },
  });
}

async function lockedSheet(bytes: Uint8Array = fixture) {
  render(<ImportKey />);
  pick(bytes);
  return await screen.findByRole("form", {
    name: "Open the encrypted database",
  });
}

function submitPassword(form: HTMLElement) {
  fireEvent.change(within(form).getByLabelText("Master password"), {
    target: { value: "correct horse battery staple" },
  });
  fireEvent.submit(form);
}

function dismiss() {
  const sheet = screen.getByRole("dialog", { name: "Import items" });
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
}

it("terminates a running KDBX worker when the import sheet is dismissed", async () => {
  const form = await lockedSheet();
  submitPassword(form);
  await waitFor(() => expect(HangingWorker.instances).toHaveLength(1));
  const worker = HangingWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledOnce();
  dismiss();
  await waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog", { name: "Import items" })).toBeNull();
  expect(listNotices().some((notice) => notice.id === "vault-import")).toBe(
    false,
  );
});

it("does not start a KDF after dismissal while wake-lock acquisition is pending", async () => {
  const form = await lockedSheet();
  let releaseRequest: (value: {
    released: boolean;
    release: () => Promise<void>;
  }) => void = () => undefined;
  const release = vi.fn(async () => undefined);
  const request = vi.fn(
    () =>
      new Promise<{ released: boolean; release: () => Promise<void> }>(
        (resolve) => {
          releaseRequest = resolve;
        },
      ),
  );
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
  submitPassword(form);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  dismiss();
  releaseRequest({ released: false, release });
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(HangingWorker.instances).toHaveLength(0);
});

it("cancels the old worker and lets a replacement file start its own", async () => {
  submitPassword(await lockedSheet());
  await waitFor(() => expect(HangingWorker.instances).toHaveLength(1));
  const old = HangingWorker.instances[0];
  pick(fixture);
  await waitFor(() => expect(old.terminate).toHaveBeenCalledOnce());
  const form = await screen.findByRole("form", {
    name: "Open the encrypted database",
  });
  await waitFor(() =>
    expect(
      within(form).getByLabelText<HTMLInputElement>("Master password").disabled,
    ).toBe(false),
  );
  submitPassword(form);
  await waitFor(() => expect(HangingWorker.instances).toHaveLength(2));
  expect(HangingWorker.instances[1].terminate).not.toHaveBeenCalled();
  dismiss();
  await waitFor(() =>
    expect(HangingWorker.instances[1].terminate).toHaveBeenCalledOnce(),
  );
});

it("explains an unsupported database version instead of calling the header invalid", async () => {
  const version5 = new Uint8Array([
    0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 1, 0, 5, 0,
  ]);
  const form = await lockedSheet(version5);
  submitPassword(form);
  expect(
    await screen.findByRole("img", { name: /version is not supported/i }),
  ).toBeTruthy();
  expect(HangingWorker.instances).toHaveLength(0);
});
