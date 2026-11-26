/** @vitest-environment jsdom */
import * as guideTargets from "@opensesame/app-core/tutorial/registry/targets.js";
import {
  type AccountItem,
  type Folder,
  type VaultItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const store = vi.hoisted(() => ({
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
}));
const copySecret = vi.hoisted(() => vi.fn());

import { useCopyFeedback } from "../../components/FieldRow.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";

const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { AccountPasswordRow } from "./AccountPasswordRow.js";
import { makeAccount } from "./account.test-support.js";
import { slottedAccount } from "./account-pepper.test-support.js";
import { ItemDetail } from "./ItemDetail.js";

const { resolveGuideTargetElement } = guideTargets;

function PasswordHarness({ item }: { item: AccountItem }) {
  const copying = useCopyFeedback();
  const method = passwordMethod(item);
  if (!method) throw new Error("Missing test password");
  return (
    <AccountPasswordRow
      item={item}
      method={method}
      title="Password"
      copying={copying}
      guide
      onSave={async () => {}}
    />
  );
}

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/vault/${id}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("account credentials", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    copySecret.mockResolvedValue("copied");
    store.saveItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  const keyed = (key: string, header = "X-Api-Key") => {
    const base = makeAccount({ id: "itm_key" });
    return {
      ...base,
      methods: [
        { id: "k", type: "api-key" as const, key, header },
        { id: "t", type: "token" as const, token: "tok_abc", expiresAt: "" },
      ],
    };
  };

  it("copies the generated portion and targets it when pepper is first", async () => {
    vault.current = { items: [slottedAccount("abcdefghij", "0")], folders: [] };
    renderAt("itm_slot");
    expect(screen.queryByRole("button", { name: "Copy password" })).toBeNull();
    const rest = screen.getByRole("button", { name: "Copy rest of password" });
    expect(resolveGuideTargetElement("item.copy-password")).toBe(rest);
    await userEvent.click(rest);
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("abcdefghij"));
  });

  it.each([
    [
      "off",
      makeAccount({ id: "plain", password: "abcdefghij" }),
      "Copy password",
    ],
    ["at the end", slottedAccount("abcdefghij"), "Copy password"],
    [
      "at the start",
      slottedAccount("abcdefghij", "0"),
      "Copy rest of password",
    ],
  ])(
    "completes after one successful copy with pepper %s",
    async (_, item, label) => {
      const report = vi.spyOn(guideTargets, "reportGuideActivation");
      render(<PasswordHarness item={item} />);
      const button = screen.getByRole("button", { name: label });
      expect(resolveGuideTargetElement("item.copy-generated")).toBe(button);
      await userEvent.click(button);
      await waitFor(() =>
        expect(report).toHaveBeenCalledWith("item.copy-generated"),
      );
      expect(copySecret).toHaveBeenCalledWith("abcdefghij");
    },
  );

  it("waits for both successful copies when pepper splits a password", async () => {
    const report = vi.spyOn(guideTargets, "reportGuideActivation");
    copySecret
      .mockResolvedValueOnce("copied")
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValueOnce("copied")
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValueOnce("copied");
    render(<PasswordHarness item={slottedAccount("abcdefghij", "3")} />);
    const first = screen.getByRole("button", { name: "Copy password" });
    const rest = screen.getByRole("button", { name: "Copy rest of password" });
    expect(resolveGuideTargetElement("item.copy-generated")).toBe(first);

    await userEvent.click(rest);
    await waitFor(() => expect(copySecret).toHaveBeenCalledTimes(1));
    expect(report).not.toHaveBeenCalledWith("item.copy-generated");
    expect(resolveGuideTargetElement("item.copy-generated")).toBe(first);
    await userEvent.click(first);
    await screen.findByRole("button", { name: "Could not copy password" });
    expect(resolveGuideTargetElement("item.copy-generated")).toBe(first);
    expect(report).not.toHaveBeenCalledWith("item.copy-generated");

    await userEvent.click(first);
    await waitFor(() =>
      expect(resolveGuideTargetElement("item.copy-generated")).toBe(rest),
    );
    expect(resolveGuideTargetElement("item.copy-password")).toBe(first);
    expect(report).not.toHaveBeenCalledWith("item.copy-generated");
    await userEvent.click(rest);
    await screen.findByRole("button", {
      name: "Could not copy rest of password",
    });
    expect(resolveGuideTargetElement("item.copy-generated")).toBe(rest);
    expect(report).not.toHaveBeenCalledWith("item.copy-generated");
    await userEvent.click(rest);
    await waitFor(() =>
      expect(report).toHaveBeenCalledWith("item.copy-generated"),
    );
    expect(copySecret.mock.calls.map(([value]) => value)).toEqual([
      "defghij",
      "abc",
      "abc",
      "defghij",
      "defghij",
    ]);
  });

  it("forgets split-copy progress when the item or password changes", async () => {
    const original = slottedAccount("abcdefghij", "3");
    const { rerender } = render(<PasswordHarness item={original} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy password" }),
    );
    await waitFor(() =>
      expect(
        resolveGuideTargetElement("item.copy-generated")?.getAttribute(
          "aria-label",
        ),
      ).toBe("Copy rest of password"),
    );
    const changed = slottedAccount("klmnopqrst", "3");
    rerender(<PasswordHarness item={changed} />);
    await waitFor(() =>
      expect(
        resolveGuideTargetElement("item.copy-generated")?.getAttribute(
          "aria-label",
        ),
      ).toMatch(/^(Copy|Copied) password$/),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^(Copy|Copied) password$/ }),
    );
    await waitFor(() =>
      expect(
        resolveGuideTargetElement("item.copy-generated")?.getAttribute(
          "aria-label",
        ),
      ).toBe("Copy rest of password"),
    );
    rerender(<PasswordHarness item={{ ...changed, id: "itm_other" }} />);
    expect(
      resolveGuideTargetElement("item.copy-generated")?.getAttribute(
        "aria-label",
      ),
    ).toBe("Copy password");
    rerender(<PasswordHarness item={changed} />);
    expect(
      resolveGuideTargetElement("item.copy-generated")?.getAttribute(
        "aria-label",
      ),
    ).toMatch(/^(Copy|Copied) password$/);
  });

  it("ignores a first copy that finishes after switching away and back", async () => {
    let finish: (result: string) => void = () => {};
    copySecret.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const original = slottedAccount("abcdefghij", "3");
    const { rerender } = render(<PasswordHarness item={original} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy password" }),
    );
    rerender(<PasswordHarness item={{ ...original, id: "itm_other" }} />);
    rerender(<PasswordHarness item={original} />);
    await act(async () => finish("copied"));
    expect(
      resolveGuideTargetElement("item.copy-generated")?.getAttribute(
        "aria-label",
      ),
    ).toMatch(/^(Copy|Copied) password$/);
  });

  it("offers editing instead of copying when pepper replaces every generated character", () => {
    vault.current = {
      items: [slottedAccount("abcdefghij", "0:")],
      folders: [],
    };
    renderAt("itm_slot");
    expect(screen.getByText("No characters to copy.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Copy .*password/ }),
    ).toBeNull();
    const edit = screen.getByRole("link", { name: "Edit" });
    expect(edit.getAttribute("href")).toBe("/vault/itm_slot/edit");
    expect(resolveGuideTargetElement("item.edit")).toBe(edit);
    expect(edit.getAttribute("data-guide-pepper-recovery")).toBe("edit");
    expect(copySecret).not.toHaveBeenCalled();
  });

  it("draws an API key as two rows like a username and password: its header, then its value", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    for (const label of ["API header", "X-Api-Key value", "Token"])
      expect(screen.getByText(label)).toBeTruthy();
    // One row each: no combined line, no second header row.
    expect(screen.queryByText("Header with key")).toBeNull();
    expect(screen.queryByText("Bearer header")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Copy api header" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Api-Key"));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy x-api-key value" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("ak_secret"));
  });

  it("hides the value until asked", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    expect(screen.queryByText("ak_secret")).toBeNull();
    // The header is plain; only the value is concealed.
    expect(screen.getByText("X-Api-Key")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Reveal x-api-key value" }),
    );
    expect(await screen.findByText("ak_secret")).toBeTruthy();
  });

  it("copies a token alone", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    await userEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("tok_abc"));
  });

  it("holds several API keys, each pair named for its header, numbered where two read alike", () => {
    const base = makeAccount({ id: "itm_key" });
    vault.current = {
      items: [
        {
          ...base,
          methods: [
            { id: "a", type: "api-key", key: "k1", header: "X-Api-Key" },
            { id: "b", type: "api-key", key: "k2", header: "X-Other" },
            { id: "c", type: "api-key", key: "k3", header: "x-api-key" },
          ],
        },
      ],
      folders: [],
    };
    renderAt("itm_key");
    for (const label of [
      "API header 1",
      "API header 2",
      "API header 3",
      "X-Api-Key value 1",
      "X-Other value",
      "x-api-key value 2",
    ])
      expect(screen.getByText(label)).toBeTruthy();
  });

  it("says a value that was never set is not set, and offers nothing to copy for it", async () => {
    vault.current = { items: [keyed("")], folders: [] };
    renderAt("itm_key");
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Copy x-api-key value" }),
    ).toBeNull();
    // The header is still there, and still copies.
    await userEvent.click(
      screen.getByRole("button", { name: "Copy api header" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Api-Key"));
  });

  it("writes a blank or colon-ended header name the usual way", async () => {
    vault.current = { items: [keyed("k1", " X-Token: ")], folders: [] };
    renderAt("itm_key");
    await userEvent.click(
      screen.getByRole("button", { name: "Copy api header" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Token"));
  });
});
