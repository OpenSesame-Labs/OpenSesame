/** @vitest-environment jsdom */
import {
  registerContributionForTest,
  resetContributionsForTest,
} from "@opensesame/app-core/lib/contributions.js";
import { discardPendingImport } from "@opensesame/app-core/lib/vault/pending-import.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { IMPORT_COMMAND } from "../../modules/vault.interop-formats/runtime.js";
import {
  FirstItemOffer,
  type PasswordTypesState,
  firstItemOfferSeams,
  passwordTypesMissing,
} from "./FirstItemOffer.js";
import { ImportKey } from "./import/ImportKey.js";

describe("FirstItemOffer", () => {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ items: [], folders: [] }),
    useVaultStore: () => ({ applyImport: vi.fn(), importSealed: vi.fn() }),
  });

  function makeFile(name: string, contents: string): File {
    const file = new File([contents], name, { type: "text/plain" });
    // jsdom's File does not implement Blob#text; the pipeline awaits it.
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(contents),
    });
    return file;
  }

  /** The empty list's offer beside the path strip's Import key, as the vault mounts them. */
  function vault(listedCount: number) {
    return (
      <MemoryRouter>
        <ImportKey />
        <div data-testid="empty">
          <FirstItemOffer
            createPath="/vault/new"
            listedCount={listedCount}
            inTrash={false}
          />
        </div>
      </MemoryRouter>
    );
  }

  afterEach(() => {
    cleanup();
    discardPendingImport();
    resetContributionsForTest();
  });

  describe("the empty vault's import offer", () => {
    it("is absent while the import capability is not registered", () => {
      render(
        <MemoryRouter>
          <FirstItemOffer
            createPath="/vault/new"
            listedCount={0}
            inTrash={false}
          />
        </MemoryRouter>,
      );
      expect(screen.getByText(/Add your first password/)).toBeTruthy();
      expect(screen.queryByText(/Import passwords instead/)).toBeNull();
    });

    it("stands only where New item makes an account", () => {
      registerContributionForTest("vault-command", IMPORT_COMMAND);
      const offer = (createPath: string) =>
        render(
          <MemoryRouter>
            <FirstItemOffer
              createPath={createPath}
              listedCount={0}
              inTrash={false}
            />
          </MemoryRouter>,
        );
      // A list narrowed to secrets opens a secret editor: no password
      // walkthrough, and no password import, is offered over it.
      const secrets = offer("/vault/new/secret");
      expect(screen.queryByText(/Add your first password/)).toBeNull();
      expect(screen.queryByText(/Import passwords instead/)).toBeNull();
      secrets.unmount();
      offer("/vault/new/account?folder=work");
      expect(screen.getByText(/Add your first password/)).toBeTruthy();
    });

    it("hands its file to the Import key, whose sheet outlives the offer", async () => {
      registerContributionForTest("vault-command", IMPORT_COMMAND);
      const user = userEvent.setup();
      const view = render(vault(0));
      const offer = within(screen.getByTestId("empty"));

      await user.click(
        offer.getByRole("button", { name: "Import passwords instead" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Choose the exported file" }),
      );
      // The offer's own picker, not the Import key's.
      fireEvent.change(offer.getByLabelText("Choose a file to import"), {
        target: { files: [makeFile("app.env", "API_KEY=sk-123\n")] },
      });
      expect(
        await screen.findByRole("dialog", { name: "Import items" }),
      ).toBeTruthy();

      // The import seals its first item: the offer is gone, the sheet is not.
      view.rerender(vault(1));
      expect(screen.queryByText(/Import passwords instead/)).toBeNull();
      expect(screen.getByRole("dialog", { name: "Import items" })).toBeTruthy();
    });
  });
});

describe("passwords", () => {
  /** The item types: shipped and permitted here, and not yet switched on. */
  const OFF: PasswordTypesState = {
    distributed: true,
    permitted: true,
    approved: false,
  };

  const original = { ...firstItemOfferSeams };
  let types: PasswordTypesState | undefined = OFF;

  function offer(listedCount = 0) {
    return render(
      <MemoryRouter>
        <FirstItemOffer
          createPath="/vault/new"
          listedCount={listedCount}
          inTrash={false}
        />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    types = OFF;
    firstItemOfferSeams.usePasswordTypes = () => types;
    firstItemOfferSeams.accountCreatable = () => false;
  });
  afterEach(() => {
    cleanup();
    resetContributionsForTest();
    Object.assign(firstItemOfferSeams, original);
  });

  describe("an empty vault with no password type (ADR 0221)", () => {
    it("says why there are no passwords and offers the switch first", () => {
      offer();
      expect(screen.getByText(/plain secrets and files only/)).toBeTruthy();
      const turnOn = screen.getByRole("button", {
        name: "Turn on passwords, cards and notes",
      });
      expect(turnOn.className).toContain("btn--primary");
      // The guided first password describes fields this vault does not have yet.
      expect(screen.queryByText(/Add your first password/)).toBeNull();
      expect(
        screen
          .getByRole("link", { name: "Add a plain secret instead" })
          .getAttribute("href"),
      ).toBe("/vault/new");
    });

    it("commits the item types on one press", async () => {
      const turnOn = vi.fn(() => Promise.resolve(null));
      firstItemOfferSeams.turnOnPasswordTypes = turnOn;
      offer();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Turn on passwords, cards and notes",
        }),
      );
      expect(turnOn).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Turn on passwords, cards and notes" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
    });

    it("offers the guided first password once the types are on", () => {
      types = { ...OFF, approved: true };
      offer();
      expect(screen.getByText(/Add your first password/)).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: "Turn on passwords, cards and notes",
        }),
      ).toBeNull();
    });

    it("does not claim there are no passwords when the Account pack is on", () => {
      // Item types as a whole are off, but Account was switched on by itself.
      firstItemOfferSeams.accountCreatable = () => true;
      offer();
      expect(screen.getByText(/Add your first password/)).toBeTruthy();
      expect(screen.queryByText(/plain secrets and files only/)).toBeNull();
    });

    it("lands focus on the road that replaces the switch", () => {
      const view = offer();
      const turnOn = screen.getByRole("button", {
        name: "Turn on passwords, cards and notes",
      });
      turnOn.focus();
      // The types come on: the switch, and the key that was pressed, are gone.
      types = { ...OFF, approved: true };
      view.rerender(
        <MemoryRouter>
          <FirstItemOffer
            createPath="/vault/new"
            listedCount={0}
            inTrash={false}
          />
        </MemoryRouter>,
      );
      expect(document.activeElement).toBe(
        screen.getByText(/Add your first password/),
      );
    });

    it("is gone with the first sealed item", () => {
      const { container } = offer(1);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("whether the switch can be offered", () => {
    it("needs the types shipped, permitted and off", () => {
      expect(passwordTypesMissing(OFF)).toBe(true);
      expect(passwordTypesMissing({ ...OFF, approved: true })).toBe(false);
      expect(passwordTypesMissing({ ...OFF, distributed: false })).toBe(false);
      expect(passwordTypesMissing({ ...OFF, permitted: false })).toBe(false);
    });

    it("is not offered before a plan has resolved", () => {
      expect(passwordTypesMissing(undefined)).toBe(false);
    });
  });
});
