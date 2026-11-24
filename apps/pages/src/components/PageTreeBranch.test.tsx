/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { PageTreeNode } from "../lib/page-to-tree.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import { PageTreeExpansionProvider } from "./page-tree-expansion.js";
import {
  setRailCursor,
  useRailCursor,
  useRailCursorFollowsRoute,
} from "./rail-cursor.js";

describe("PageTreeBranch", () => {
  afterEach(() => {
    cleanup();
    setRailCursor(null);
  });

  function node(extra: Partial<PageTreeNode>): PageTreeNode {
    return {
      id: "danger",
      label: "Danger",
      href: "/settings/danger",
      children: [],
      branch: true,
      ...extra,
    };
  }

  describe("a rail row with nothing under it", () => {
    it("is a place, drawn without a caret or a count", () => {
      render(
        <MemoryRouter>
          <PageTreeBranch node={node({})} level={2} current="/settings" />
        </MemoryRouter>,
      );
      const row = screen.getByRole("treeitem", { name: "Danger" });
      expect(row.hasAttribute("aria-expanded")).toBe(false);
      expect(row.querySelector(".railtree__count")).toBeNull();
    });

    it("stays a directory when it lists records, even none yet", () => {
      render(
        <MemoryRouter>
          <PageTreeBranch
            node={node({ label: "Devices", collection: true })}
            level={2}
            current="/identity"
          />
        </MemoryRouter>,
      );
      const row = screen.getByRole("treeitem", { name: "Devices" });
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(row.querySelector(".railtree__count")?.textContent).toBe("-");
    });
  });

  function Probe() {
    const tree = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const location = useLocation();
    const cursor = useRailCursor();
    useRailCursorFollowsRoute(tree, location.pathname);
    return (
      <>
        <div ref={tree} />
        <output>{cursor ?? "none"}</output>
        <button type="button" onClick={() => navigate("/vault")}>
          go
        </button>
      </>
    );
  }

  describe("the rail cursor", () => {
    it("is dropped when the page moves while focus is outside the rail", () => {
      render(
        <MemoryRouter initialEntries={["/settings/danger"]}>
          <Probe />
        </MemoryRouter>,
      );
      // The cursor is left on Settings › Danger, then a link in the page
      // (not the rail) moves to the vault: Danger must not stay selected.
      act(() => setRailCursor("rail-settings-danger"));
      expect(screen.getByRole("status").textContent).toBe(
        "rail-settings-danger",
      );
      act(() => screen.getByRole("button", { name: "go" }).click());
      expect(screen.getByRole("status").textContent).toBe("none");
    });
  });
});

describe("remount", () => {
  const sessions = {
    id: "sessions",
    label: "Sessions",
    href: "/access?view=sessions",
    branch: true,
    children: [
      {
        id: "access-receipts",
        label: "Receipts",
        href: "/access?view=sessions#access-receipts",
        branch: false,
        children: [],
      },
    ],
  };

  /** Changing the mounted workspace replaces the phone tree, as the real Access panels do. */
  function PhoneWorkspaces() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <>
        <div key={location.search}>
          <PageTreeBranch
            node={sessions}
            level={2}
            current={location.pathname + location.search + location.hash}
          />
        </div>
        <button type="button" onClick={() => navigate("/access")}>
          Back to sections
        </button>
        <output aria-label="Route">
          {location.pathname + location.search + location.hash}
        </output>
      </>
    );
  }

  function Workspaces({ vault }: { vault: string }) {
    return (
      <MemoryRouter initialEntries={["/access"]}>
        <PageTreeExpansionProvider key={vault}>
          <PhoneWorkspaces />
        </PageTreeExpansionProvider>
      </MemoryRouter>
    );
  }

  afterEach(cleanup);

  describe("phone page branches across record workspaces", () => {
    it("retains explicit expansion when a panel remounts, so its Receipts leaf is reachable", () => {
      render(<Workspaces vault="personal" />);
      expect(
        screen
          .getByRole("treeitem", { name: "Sessions" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      expect(screen.queryByRole("treeitem", { name: "Receipts" })).toBeNull();
      fireEvent.click(screen.getByRole("treeitem", { name: "Sessions" }));
      fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
      expect(
        screen
          .getByRole("treeitem", { name: "Sessions" })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      fireEvent.click(screen.getByRole("treeitem", { name: "Receipts" }));
      expect(screen.getByLabelText("Route").textContent).toBe(
        "/access?view=sessions#access-receipts",
      );
      fireEvent.click(screen.getByRole("treeitem", { name: "Sessions" }));
      fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
      expect(screen.queryByRole("treeitem", { name: "Receipts" })).toBeNull();
    });

    it("shares explicit choices with another mounted tree when the viewport changes", () => {
      render(
        <MemoryRouter>
          <PageTreeExpansionProvider>
            <PageTreeBranch node={sessions} level={2} current="/access" />
            <PageTreeBranch node={sessions} level={2} current="/access" />
          </PageTreeExpansionProvider>
        </MemoryRouter>,
      );
      const branches = screen.getAllByRole("treeitem", { name: "Sessions" });
      fireEvent.click(branches[0]);
      expect(
        branches.map((branch) => branch.getAttribute("aria-expanded")),
      ).toEqual(["true", "true"]);
      expect(
        screen.getAllByRole("treeitem", { name: "Receipts" }),
      ).toHaveLength(2);
      fireEvent.click(branches[1]);
      expect(
        branches.map((branch) => branch.getAttribute("aria-expanded")),
      ).toEqual(["false", "false"]);
      expect(screen.queryByRole("treeitem", { name: "Receipts" })).toBeNull();
    });

    it("discards expansion when the vault changes or its unlocked shell ends", () => {
      const { rerender } = render(<Workspaces vault="personal" />);
      fireEvent.click(screen.getByRole("treeitem", { name: "Sessions" }));
      expect(screen.getByRole("treeitem", { name: "Receipts" })).toBeTruthy();
      rerender(<Workspaces vault="work" />);
      expect(screen.queryByRole("treeitem", { name: "Receipts" })).toBeNull();
      fireEvent.click(screen.getByRole("treeitem", { name: "Sessions" }));
      rerender(<div>Locked</div>);
      rerender(<Workspaces vault="work" />);
      expect(screen.queryByRole("treeitem", { name: "Receipts" })).toBeNull();
    });
  });
});
