import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import { performHostedInference } from "../hosted-inference.js";
import {
  MODEL_TEST_SECRET,
  saveModelFixture,
} from "../hosted-model.test-support.js";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import { loadNativeConnectorRecord } from "../native-connector-store.js";
import { createProject, setActiveProject } from "../projects.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { aiConnectionDraft } from "./presets.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";

describe("runtime", () => {
  let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
  let release = () => {};
  let lifetime: AbortController;
  const key = "private-actual-vault-ai-token";
  const draft = () => ({
    ...aiConnectionDraft("byo-ai"),
    baseUrl: "https://models.example/custom/v1",
    model: "test-model",
    apiKey: key,
  });
  const answer = () =>
    Response.json({ choices: [{ message: { content: "Model answer" } }] });
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(async () => {
    fixture = await runtimeFixture();
    lifetime = new AbortController();
    fetcher = vi.fn(async () => answer());
    release = bindAiConnectionTransport({
      fetch: fetcher,
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
    });
  });
  afterEach(async () => {
    release();
    lifetime.abort();
    await fixture.close();
  });

  it("probes without saving; saving stores a real Token credential and metadata-only reference", async () => {
    await expect(testAiConnection(draft())).resolves.toBe(
      "Model inference verified",
    );
    expect(readDeviceRows()).toHaveLength(0);
    expect(vaultStore.getSnapshot().items).toHaveLength(0);
    const saved = await saveAiConnection(draft());
    expect(saved.status).toBe("connected");
    expect(readAiConnection(saved.connectionId)?.apiKey).toBe("");
    const items = vaultStore.getSnapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "credential",
      method: { type: "token", token: key },
    });
    const record = loadNativeConnectorRecord(saved.connectionId);
    expect(
      record?.privateState.credentials.ai_credential_reference,
    ).toBeTruthy();
    expect(JSON.stringify(readDeviceRows())).not.toContain(key);
    expect(JSON.stringify(readDeviceSecrets())).not.toContain(key);
    expect([...fixture.files.values()].join()).not.toContain(key);
  });

  it("runs the saved endpoint through the existing hosted inference entry and forgets its exact credential", async () => {
    const saved = await saveAiConnection(draft());
    const releaseAuthority = bindHostedModelAuthority({
      fetch: fetcher,
      assertCurrent: vi.fn(),
      read: () => ({
        connectionId: saved.connectionId,
        providerId: "byo-ai",
        method: "api-key",
        status: "connected",
        model: "test-model",
        endpoint: draft().baseUrl,
      }),
      connections: () => [],
      execute: vi.fn(),
    });
    try {
      const result = await performHostedInference(
        saved.connectionId,
        {
          model: "test-model",
          messages: [{ role: "user", content: "Question" }],
        },
        { fetch: fetcher, assertCurrent: vi.fn(), signal: lifetime.signal },
      );
      expect(result.answer).toBe("Model answer");
      expect(String(fetcher.mock.calls[1]?.[0])).toBe(
        "https://models.example/custom/v1/chat/completions",
      );
      await deleteAiConnection(saved.connectionId);
      expect(readDeviceRows()).toHaveLength(0);
      expect(vaultStore.getSnapshot().items).toHaveLength(0);
    } finally {
      releaseAuthority();
    }
  });

  it("retains an unchanged target key, but never forwards it to an edited endpoint", async () => {
    const saved = await saveAiConnection(draft());
    const unchanged = { ...draft(), apiKey: "", name: "Renamed model" };
    await saveAiConnection(unchanged, saved.connectionId);
    expect(vaultStore.getSnapshot().items).toHaveLength(1);
    const before = fetcher.mock.calls.length;
    await expect(
      saveAiConnection(
        { ...unchanged, baseUrl: "https://other.example/v1" },
        saved.connectionId,
      ),
    ).rejects.toThrow(/new API key/);
    expect(fetcher.mock.calls).toHaveLength(before);
  });

  it("rejects after vault lock before another request can leave", async () => {
    const saved = await saveAiConnection(draft());
    vaultStore.lock();
    await expect(
      performSavedAiInference(saved.connectionId, {
        model: "test-model",
        messages: [{ role: "user", content: "Question" }],
      }),
    ).rejects.toThrow(/Unlock/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires re-verification when the actual vault token changes behind its saved reference", async () => {
    const saved = await saveAiConnection(draft());
    const token = vaultStore.getSnapshot().items[0];
    if (!token || token.kind !== "credential" || token.method.type !== "token")
      throw new Error("Missing actual Token credential");
    await vaultStore.saveItem({
      ...token,
      method: { ...token.method, token: "replacement-not-yet-verified" },
    });
    await expect(
      performSavedAiInference(saved.connectionId, {
        model: "test-model",
        messages: [{ role: "user", content: "Question" }],
      }),
    ).rejects.toThrow(/credential changed/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("upgrades an existing native API-key record in place after explicit credential reentry", async () => {
    const id = await saveModelFixture("openai", true, "legacy-openai");
    const next = {
      ...aiConnectionDraft("openai"),
      model: "test-model",
      apiKey: "",
    };
    await expect(saveAiConnection(next, id)).rejects.toThrow(
      /move this connection/,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const saved = await saveAiConnection({ ...next, apiKey: key }, id);
    expect(saved.connectionId).toBe(id);
    expect(saved.status).toBe("connected");
    expect(readAiConnection(id)?.model).toBe("test-model");
    expect(vaultStore.getSnapshot().items).toHaveLength(1);
    expect(JSON.stringify(readDeviceSecrets())).not.toContain(
      MODEL_TEST_SECRET,
    );
    expect(JSON.stringify(readDeviceSecrets())).not.toContain(key);
  });
});

describe("recovery", () => {
  let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
  let release = () => {};
  const fetcher = vi.fn(async () =>
    Response.json({ choices: [{ message: { content: "Verified" } }] }),
  );
  beforeEach(async () => {
    fixture = await runtimeFixture();
    fetcher.mockClear();
    release = bindAiConnectionTransport({
      fetch: fetcher,
      signal: new AbortController().signal,
      assertCurrent() {},
    });
  });
  afterEach(async () => {
    release();
    await fixture.close();
  });
  async function saved() {
    return saveAiConnection({
      ...aiConnectionDraft("byo-ai"),
      baseUrl: "https://models.example/v1",
      model: "fixture-model",
      apiKey: "fixture-ai-custody-removal-key",
    });
  }
  function token() {
    const item = vaultStore.getSnapshot().items[0];
    if (item?.kind !== "credential" || item.method.type !== "token")
      throw new Error("Expected the integration token");
    return structuredClone(item);
  }

  it.each(["missing", "edited", "invalid binding"])(
    "removes dead AI metadata after %s custody while refusing inference and preserving the item",
    async (change) => {
      const connection = await saved();
      const item = token();
      if (change === "missing") await vaultStore.trashItem(item.id);
      else {
        if (change === "edited" && item.method.type === "token")
          item.method.token = "user-edited-fixture-key";
        else item.fields = [];
        await vaultStore.saveItem(item);
      }
      const expected = structuredClone(vaultStore.getSnapshot().items);
      const calls = fetcher.mock.calls.length;
      await expect(
        performSavedAiInference(connection.connectionId, {
          model: "fixture-model",
          messages: [{ role: "user", content: "Do not dispatch" }],
        }),
      ).rejects.toThrow();
      expect(fetcher.mock.calls).toHaveLength(calls);
      await expect(
        deleteAiConnection(connection.connectionId),
      ).resolves.toBeUndefined();
      expect(readAiConnection(connection.connectionId)).toBeNull();
      expect(vaultStore.getSnapshot().items).toEqual(expected);
    },
  );

  it("preserves a real user edit during metadata removal rather than deleting the newly edited token", async () => {
    const connection = await saved();
    const item = token();
    if (item.method.type === "token")
      item.method.token = "queued-user-fixture-key";
    fixture.beforeAtomicWrite(async () => {
      fixture.beforeAtomicWrite();
      await vaultStore.saveItem(item);
    });
    await expect(
      deleteAiConnection(connection.connectionId),
    ).resolves.toBeUndefined();
    expect(readAiConnection(connection.connectionId)).toBeNull();
    expect(token().method).toEqual(item.method);
  });

  it("does not remove dangling metadata after a vault lock during durable publication", async () => {
    const connection = await saved();
    await vaultStore.trashItem(token().id);
    await vaultStore.flushPendingWrites();
    await vfsFlush();
    fixture.beforeAtomicWrite(async () => {
      fixture.beforeAtomicWrite();
      vaultStore.lock();
    });
    await expect(deleteAiConnection(connection.connectionId)).rejects.toThrow();
    await vaultStore.unlock(runtimePassword);
    expect(readAiConnection(connection.connectionId)).not.toBeNull();
    expect(readDeviceRows()).toHaveLength(1);
  });

  it("does not treat missing credentials as permission to remove another vault's metadata", async () => {
    const connection = await saved();
    await vaultStore.trashItem(token().id);
    await vaultStore.flushPendingWrites();
    await vfsFlush();
    const project = await createProject("AI credential recovery isolation");
    await setActiveProject(project.id);
    vaultStore.loadActiveProjectScope();
    await vaultStore.create("a different actual vault fixture password");
    await expect(deleteAiConnection(connection.connectionId)).rejects.toThrow(
      /vault/,
    );
    expect(readAiConnection(connection.connectionId)).not.toBeNull();
    await setActiveProject("personal");
    vaultStore.loadActiveProjectScope();
  });
});
