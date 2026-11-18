/** @vitest-environment jsdom */
import { createItem } from "@opensesame/vault-core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  input,
  installEditorHarness,
  open,
  passwordOf,
  saveItem,
  saved,
  vault,
} from "./account-editor.test-support.js";
import { switchGenerator } from "./account-secrets.js";

describe("generating a password for a saved account", () => {
  installEditorHarness();

  it.each([true, false])(
    "generates locally with a website (guest: %s)",
    async (guest) => {
      const item = createItem("account", "Webmail");
      item.id = "itm_1";
      item.uris = [
        { id: "site", uri: "https://example.test", match: "domain" },
      ];
      const initial = item.methods[0];
      if (initial?.type !== "password")
        throw new Error("missing password method");
      item.methods = [switchGenerator(initial, "rules")];
      vault.current = { items: [item], folders: [], guest };
      open("/vault/itm_1/edit");
      const password = input("Password");
      const before = password.value;
      await userEvent.click(
        screen.getByRole("button", { name: "Generate another password" }),
      );
      await waitFor(() => expect(password.value).not.toBe(before));
      expect(password.value).not.toBe("");
      expect(saveItem).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Save item" }));
      await waitFor(() => expect(saveItem).toHaveBeenCalled());
      expect(passwordOf(saved()).secret).toBe(password.value);
    },
  );
});
