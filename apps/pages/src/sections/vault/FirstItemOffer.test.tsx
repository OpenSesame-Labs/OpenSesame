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
import { afterEach, describe, expect, it, vi } from "vitest";

import { vaultHooksSeams } from "../../lib/vault/hooks.js";

Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], folders: [] }),
  useVaultStore: () => ({ applyImport: vi.fn(), importSealed: vi.fn() }),
});

import { IMPORT_COMMAND } from "../../modules/vault.interop-formats/runtime.js";
import { FirstItemOffer } from "./FirstItemOffer.js";
import { ImportKey } from "./import/ImportKey.js";

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
