/**
 * GUEST-V1 storage order, CONN-S1, LOCAL-D1 and EXT-O1 correspondence: every
 * vector the Lean model prints is replayed against the real implementation.
 */
import { readFileSync } from "node:fs";
import { mintVaultKey, vaultSealBinding } from "@opensesame/vault-core";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import * as page from "../../../apps/browser-extension/runner/page-fns.js";
import { configureHost } from "../../../packages/app-core/src/host.js";
import { webLocksDouble } from "../../../packages/app-core/src/lib/__tests__/web-locks-double.js";
import * as directory from "../../../packages/app-core/src/lib/connector-directory.js";
import { DECOY_SCRATCH_TOMB } from "../../../packages/app-core/src/lib/duress/store/decoy-scratch.js";
import { newGuestVaultId } from "../../../packages/app-core/src/lib/guest-vault-id.js";
import { kvGet, kvSeams } from "../../../packages/app-core/src/lib/kv.js";
import { promoteGuestVault } from "../../../packages/app-core/src/lib/vault/guest-vault-promotion.js";
import { emitVaultLock } from "../../../packages/app-core/src/lib/vault/lock-events.js";
import { prepareGuestOpen } from "../../../packages/app-core/src/lib/vault/store-guest-material.js";
import { publishOriginalHeader } from "../../../packages/app-core/src/lib/vault/store-header-publication.js";
import { vercelConnectAuth } from "../../../packages/app-core/src/lib/vercel-connect.js";
import * as vercel from "../../../packages/app-core/src/lib/vercel-connect-session.js";
import * as vfs from "../../../packages/app-core/src/lib/vfs.js";
import * as transient from "../../../packages/app-core/src/lib/vfs-transient-guest.js";
import { createTestHost } from "../../../packages/app-core/src/test-host.js";

const vectors = process.env.OPENSESAME_GUEST_FORMAL_VECTORS;
if (!vectors)
  throw new Error("Run spec/formal/guest/verify.sh for Lean vectors");
const rows = readFileSync(vectors, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
const group = (kind: string) =>
  rows.filter((row) => row[0] === kind).map((row) => row.slice(1));
const setDurable = kvSeams.kvSetDurable;
const [yes, no] = [() => "1", () => "0"];
const settle = <T>(work: Promise<T>) => work.then(yes, no);

afterEach(() => {
  kvSeams.kvSetDurable = setDurable;
  vfs.lockAllTombs();
  configureHost(createTestHost());
});
it("guest opening agrees with `guestScope` and `prepareOpen`", async () => {
  const cases = group("open");
  expect(cases).toHaveLength(10);
  configureHost(createTestHost({ locks: webLocksDouble() }));
  const seen = new Set<string>();
  for (const [decoy, at, scope, opened, left] of cases) {
    let calls = 0;
    const check = () => {
      if (String(calls++) === at) throw new Error("ended");
    };
    const lease = async (tomb: string) => ({ tomb, release: async () => {} });
    // SAFETY: a fixture person; prepareGuestOpen only carries it through and nothing here publishes it.
    const options = { decoy: decoy === "1", guestPerson: {} as never };
    let tomb = "";
    const abandon = async (
      held: { tomb: string; release: () => Promise<void> } | null,
    ) => {
      tomb = held?.tomb ?? tomb;
      await held?.release();
    };
    const done = await settle(
      prepareGuestOpen(options, check, lease, abandon).then((open) => {
        tomb = open.scope.tomb;
        return open.lease?.release();
      }),
    );
    if (done === "1") {
      expect(tomb === DECOY_SCRATCH_TOMB ? "scratch" : "fresh").toBe(scope);
      expect(seen.has(tomb) && scope === "fresh").toBe(false);
      seen.add(tomb);
    }
    const kept = tomb !== "" && transient.isTransientGuest(tomb) ? "1" : "0";
    expect([done, kept]).toEqual([opened, left]);
  }
});
it("header publication agrees with `publish`", async () => {
  const cases = group("publish");
  expect(cases).toHaveLength(10);
  for (const [scratch, fail, written, ok] of cases) {
    const tomb = scratch === "1" ? DECOY_SCRATCH_TOMB : newGuestVaultId();
    if (scratch !== "1") transient.beginTransientGuest(tomb);
    let phase = "beforePrepare";
    let thrown = false;
    const check = () => {
      if (phase === "inWrite" && vfs.readPlaintextFile(tomb, "header"))
        phase = "afterWrite";
      if (phase !== fail || thrown) return;
      thrown = true;
      throw new Error("ended");
    };
    const text = () => {
      phase = "inWrite";
      return '{"v":1}';
    };
    const prepare = async () => {
      phase = "afterPrepare";
    };
    const done = await settle(
      publishOriginalHeader(tomb, text, null, check, prepare, () => {}),
    );
    const header = vfs.readPlaintextFile(tomb, "header") ? "1" : "0";
    expect([header, done]).toEqual([written, ok]);
  }
});
it("promotion agrees with `promote`: the header is the last durable write", async () => {
  const cases = group("promote");
  expect(cases).toHaveLength(13);
  configureHost(createTestHost({ locks: webLocksDouble() }));
  for (const [at, committed, header] of cases) {
    const tomb = newGuestVaultId();
    const owner = transient.beginTransientGuest(tomb);
    const file = (path: string) => vfs.tombFileKey(tomb, path);
    const gate = { v: 1, createdAt: "x", unlocks: { pin: {} } };
    await transient.writeTransientGuest(file("header"), JSON.stringify(gate));
    await transient.writeTransientGuest(file("body"), "b");
    await transient.writeTransientGuest(file("index"), "i");
    const order: string[] = [];
    kvSeams.kvSetDurable = async (key, value, before) => {
      const index = order.push(key) - 1;
      if (String(index) !== at) return setDurable(key, value, before);
      if (committed === "1") await setDurable(key, value, before);
      throw new Error("interrupted");
    };
    const done = await settle(promoteGuestVault(tomb, owner, () => {}));
    kvSeams.kvSetDurable = setDurable;
    expect(kvGet(file("header")) ? "1" : "0").toBe(header);
    expect(done).toBe(header);
    const files = ["promotion.v1", "body", "index", "header"].map(file);
    if (at === "-") expect(order).toEqual(["tombs.v1", ...files, "tombs.v1"]);
  }
});
it("deletion agrees with `deletionPlan`: journal, unlink, index, idle", async () => {
  const cases = group("deletion");
  expect(cases).toHaveLength(5);
  for (const [at, completed] of cases) {
    configureHost(createTestHost({ locks: webLocksDouble() }));
    const tomb = newGuestVaultId();
    const { vaultKey } = await mintVaultKey();
    vfs.unlockTomb(tomb, vaultKey);
    const journal = vfs.tombFileKey(tomb, "guest-delete-journal.v1");
    const seal = await vfs.vfsSeams.seal(
      vaultKey,
      { v: 1, idle: true },
      vaultSealBinding(tomb, "guest-delete-journal.v1"),
    );
    await setDurable(journal, JSON.stringify(seal));
    await vfs.writeFile(tomb, "config/note", new TextEncoder().encode("x"));
    const { writeRawGuarded, deleteRawGuarded } = vfs.vfsSeams;
    if (!writeRawGuarded || !deleteRawGuarded) throw new Error("no guards");
    const done: string[] = [];
    const effect = async (name: string, run: () => Promise<void>) => {
      if (String(done.length) === at) throw new Error("interrupted");
      await run();
      done.push(name);
    };
    vfs.vfsSeams.writeRawGuarded = (key, value, check, k) => {
      const name =
        key === journal ? (done.length ? "idle" : "journal") : "index";
      return effect(name, () => writeRawGuarded(key, value, check, k));
    };
    vfs.vfsSeams.deleteRawGuarded = (key, check) =>
      effect("unlink", () => deleteRawGuarded(key, check));
    try {
      await settle(vfs.deleteFile(tomb, "config/note"));
    } finally {
      Object.assign(vfs.vfsSeams, { writeRawGuarded, deleteRawGuarded });
    }
    expect(done.join(",")).toBe(completed ?? "");
  }
});
/** The credential sealed in each session's vault, read back with its key. */
async function sealedRecords(
  kind: "directory" | "vercel",
  keys: Map<number, [string, CryptoKey]>,
  session: number,
) {
  const sealed: string[] = [];
  for (let v = 0; v <= session; v++) {
    const entry = keys.get(v);
    if (entry) vfs.unlockTomb(...entry);
    const read =
      entry && kind === "directory"
        ? directory.readConnectorDirectory(entry[0]).then((r) => r?.key)
        : entry && vercel.readVercelConnectAuth(entry[0]).then((r) => r?.token);
    sealed.push((await read)?.slice(1) ?? "-");
    vfs.lockAllTombs();
  }
  return sealed;
}
/** Drive one staging trace; each step reports pending/live as the model does. */
async function staging(kind: "directory" | "vercel", ops: string[]) {
  const id = crypto.randomUUID();
  const keys = new Map<number, [string, CryptoKey]>();
  const path =
    kind === "directory"
      ? "config/connector-directory"
      : vercel.CONNECT_AUTH_PATH;
  type Write = {
    decide: (ok: boolean) => void;
    ok: Promise<boolean>;
    work: Promise<unknown>;
    state: string;
  };
  const writes: Write[] = [];
  let head = 0;
  let reached: () => void = () => {};
  let session = 0;
  let vault: string | null = null;
  let unlock = new AbortController();
  kvSeams.kvSetDurable = async (key, value, before) => {
    const next = writes.find((write) => write.state === "queued");
    if (!key.endsWith(`/${path}`) || !next)
      return setDurable(key, value, before);
    next.state = "arrived";
    reached();
    if (!(await next.ok)) throw new Error("write failed");
    return setDurable(key, value, before);
  };
  // Writes to one tomb are serialized, so only the oldest open write can arrive now.
  const queue = async <T>(work: Promise<T>) => {
    let decide: (ok: boolean) => void = () => {};
    const ok = new Promise<boolean>((resolve) => (decide = resolve));
    const write: Write = { decide, ok, work, state: "queued" };
    const open = writes.slice(head).some((other) => other.state !== "settled");
    writes.push(write);
    work
      .catch(() => undefined)
      .finally(() => {
        if (write.state === "queued") write.state = "settled";
      });
    if (open) return;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    await Promise.race([arrived, work.catch(() => undefined)]);
  };
  const tag = (value: string | undefined) => value?.slice(1) ?? "-";
  const pending = () =>
    tag(
      kind === "directory"
        ? directory.pendingConnectorDirectory()?.key
        : vercel.pendingVercelConnectAuth()?.token,
    );
  let sync: Promise<unknown> | null = null;
  let listed: () => void = () => {};
  directory.connectorDirectorySeams.listDirectory = () =>
    new Promise(
      (resolve) =>
        (listed = () => resolve({ integrations: [], connections: [] })),
    );
  const seal = async (unlocked: string) => {
    const staged = directory.pendingConnectorDirectory() !== null;
    const work = directory.sealPendingConnectorDirectory(unlocked);
    if (staged) await queue(work);
    else await work;
  };
  const hydrate = async (unlocked: string) => {
    const staged = vercel.pendingVercelConnectAuth() !== null;
    const work = vercel.hydrateVercelConnectAuth(unlocked, {
      signal: unlock.signal,
    });
    if (staged) await queue(work);
    else await work.catch(() => undefined);
  };
  const settleWrite = async (ok: boolean) => {
    const write = writes[head++];
    write?.decide(ok);
    await write?.work.catch(() => undefined);
  };
  const stage = async () => {
    sync = directory.syncConnectorDirectory({
      endpoint: "https://dir.example",
      key: `k${session}`,
      tomb: null,
    });
    sync.catch(() => undefined);
  };
  const staged = async () => {
    listed();
    await sync?.catch(() => undefined);
  };
  const lock = async () => {
    unlock.abort();
    unlock = new AbortController();
    emitVaultLock();
    vfs.lockAllTombs();
    vault = null;
    session += 1;
  };
  const open = async () => {
    vault = `formal-${id}-${session}`;
    const { vaultKey } = await mintVaultKey();
    keys.set(session, [vault, vaultKey]);
    vfs.unlockTomb(vault, vaultKey);
  };
  const arm = () => vercel.armVercelConnectAuth({ token: `t${session}` }, null);
  const steps = new Map([
    ["stage", stage],
    ["staged", staged],
    ["seal", async () => vault && (await seal(vault))],
    ["hydrate", async () => vault && (await hydrate(vault))],
    ["arm", arm],
    ["ok", () => settleWrite(true)],
    ["fail", () => settleWrite(false)],
    ["lock", lock],
    ["unlock", open],
  ]);
  const out: string[] = [];
  for (const op of ops) {
    await steps.get(op)?.();
    const live = kind === "vercel" ? tag(vercelConnectAuth()?.token) : "-";
    out.push(`${op}:${pending()}/${live}`);
  }
  for (const write of writes) write.decide(false);
  emitVaultLock();
  vfs.lockAllTombs();
  const sealed = await sealedRecords(kind, keys, session);
  kvSeams.kvSetDurable = setDurable;
  return `${out.join(",")}\t${sealed.join("/")}`;
}
for (const kind of ["directory", "vercel"] as const)
  it(`${kind} staging agrees with \`dstep\` on every enabled trace`, async () => {
    const cases = group(kind);
    expect(cases.length).toBe(kind === "directory" ? 1155 : 1349);
    for (const [trace, sealed] of cases) {
      const ops = trace
        ? trace.split(",").map((step) => step.split(":")[0] ?? "")
        : [];
      expect(await staging(kind, ops)).toBe(`${trace}\t${sealed}`);
    }
  });
it("page functions agree with `pageReads`/`pageActs` (EXT-O1)", () => {
  const cases = group("page");
  expect(cases).toHaveLength(8 * 3 * 2);
  const site = "https://rp.example";
  for (const [fn, win, moved, reads, acts] of cases) {
    const dom = new JSDOM(
      '<input id="a" type="text"><button id="go" type="button">Go</button>',
      { url: `${site}/`, runScripts: "outside-only" },
    );
    const doc = dom.window.document;
    let pressed = 0;
    doc.getElementById("go")?.addEventListener("click", () => pressed++);
    const field = doc.body.firstElementChild;
    if (moved === "1")
      field?.addEventListener("focus", () =>
        dom.reconfigure({ url: "https://evil.example/" }),
      );
    const target =
      win === "none" ? doc.implementation.createHTMLDocument("") : doc;
    let touched = 0;
    const [query, all, walk, root] = [
      target.querySelector.bind(target),
      target.querySelectorAll.bind(target),
      target.createTreeWalker.bind(target),
      target.documentElement,
    ];
    const count = () => touched++;
    Object.defineProperties(target, {
      querySelector: { value: (s: string) => [count(), query(s)][1] },
      querySelectorAll: { value: (s: string) => [count(), all(s)][1] },
      createTreeWalker: {
        value: (r: Node, w: number) => [count(), walk(r, w)][1],
      },
      documentElement: { get: () => [count(), root][1] },
    });
    const origin = win === "other" ? "https://evil.example" : site;
    const calls = [
      ["waitFor", page.pfWaitFor, ["#a", 10, origin]],
      ["fill", page.pfFill, ["#a", "v", origin]],
      ["presence", page.pfPresence, ["#a", "v", origin]],
      ["submit", page.pfSubmit, ["#go", origin]],
      ["layout", page.pfLayout, [origin]],
      ["readDom", page.pfReadDom, [[], origin]],
      ["mask", page.pfMask, [["#a"], origin]],
      ["unmask", page.pfUnmask, [origin]],
    ] as const;
    const [, source, args] = calls.find(([name]) => name === fn) ?? [];
    const run = dom.window.eval(`(document) => (${String(source)})`)(target);
    try {
      const result = run(...(args ?? []));
      if (result instanceof dom.window.Promise) result.catch(() => undefined);
    } catch {
      // off_origin
    }
    const read = touched > 0 ? "1" : "0";
    const filled =
      field instanceof dom.window.HTMLInputElement && field.value === "v";
    const acted = pressed > 0 || filled ? "1" : "0";
    expect([fn, win, moved, read, acted]).toEqual([
      fn,
      win,
      moved,
      reads,
      acts,
    ]);
    dom.window.close();
  }
});
