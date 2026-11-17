/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import {
  GUIDE_OVERLAY_ROUTES,
  isKnownGuideRoute,
} from "@opensesame/app-core/tutorial/registry/routes.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { stubSupportController } from "./support-controller.test-support.js";
import { useSupportRouteSync } from "./use-support-route.js";

const github = "/settings/connections/github";
const otherGithub = "/connections/github";
const late = "/settings/test-late-guide";
const sibling = "/settings/connections/github-other";
const gate = "/unlock/form";
const routeIds = [github, otherGithub, late];

type Action =
  | "arrive-github"
  | "arrive-github-child"
  | "arrive-other-github"
  | "arrive-late"
  | "arrive-sibling"
  | "arrive-vault"
  | "load"
  | "unload"
  | "gate-on"
  | "gate-off"
  | "ask-gate"
  | "ask-settings";

function expectedContext(path: string, loaded: boolean): string {
  if (path === github || path.startsWith(`${github}/`)) return github;
  if (path === otherGithub) return otherGithub;
  if (path === late) return loaded ? late : "/settings";
  if (path === sibling) return "/settings";
  return path;
}

function scenario(actions: readonly Action[]): void {
  const { support } = stubSupportController("/vault");
  const setRoute = vi.fn();
  support.setRoute = setRoute;
  let guideNavigate: (route: string) => void = () => {
    throw new Error("Guide navigator was not registered");
  };
  support.setNavigator = (navigator) => {
    guideNavigate = navigator;
  };
  let userNavigate: (path: string) => void = () => {
    throw new Error("Router was not mounted");
  };

  function Harness({ override }: { override: string | null }) {
    useSupportRouteSync(support, override);
    userNavigate = useNavigate();
    return (
      <output data-testid="actual-location">{useLocation().pathname}</output>
    );
  }
  const tree = (override: string | null) => (
    <MemoryRouter initialEntries={["/settings"]}>
      <Harness override={override} />
    </MemoryRouter>
  );
  const view = render(tree(null));
  let path = "/settings";
  let loaded = false;
  let override: string | null = null;
  let revoke: (() => void) | null = null;

  function check(): void {
    expect(screen.getByTestId("actual-location").textContent).toBe(path);
    expect(setRoute).toHaveBeenLastCalledWith(
      override ?? expectedContext(path, loaded),
    );
    // Context alone never registers a tour destination; only the contribution
    // makes the optional routes known to the guide compiler.
    for (const id of routeIds) expect(isKnownGuideRoute(id), id).toBe(loaded);
  }

  function arrive(destination: string): void {
    path = destination;
    act(() => userNavigate(path));
  }

  function load(): void {
    if (loaded) return;
    act(() => {
      const revokes = routeIds.map((id) =>
        registerContributionForTest("tutorial-route", {
          id,
          title: `Example ${id}`,
        }),
      );
      revoke = () => {
        for (const stop of revokes) stop();
      };
    });
    loaded = true;
  }

  function unload(): void {
    if (!revoke) return;
    act(revoke);
    revoke = null;
    loaded = false;
  }

  function setGate(active: boolean): void {
    override = active ? gate : null;
    view.rerender(tree(override));
  }

  const handlers = {
    "arrive-github": () => arrive(github),
    "arrive-github-child": () => arrive(`${github}/installation`),
    "arrive-other-github": () => arrive(otherGithub),
    "arrive-late": () => arrive(late),
    "arrive-sibling": () => arrive(sibling),
    "arrive-vault": () => arrive("/vault"),
    load,
    unload,
    "gate-on": () => setGate(true),
    "gate-off": () => setGate(false),
    "ask-gate": () => {
      // Every declared gate is refused, not just the currently open one.
      act(() => {
        for (const target of GUIDE_OVERLAY_ROUTES) guideNavigate(target);
      });
    },
    "ask-settings": () => {
      path = "/settings";
      act(() => guideNavigate(path));
    },
  };

  try {
    check();
    for (const action of actions) {
      handlers[action]();
      check();
    }
  } finally {
    if (revoke) act(revoke);
    view.unmount();
  }
}

afterEach(cleanup);

it("preserves the screen and available destinations while contributions change", () => {
  scenario([
    "arrive-github",
    "load",
    "unload",
    "arrive-late",
    "load",
    "gate-on",
    "ask-gate",
    "gate-off",
    "unload",
    "arrive-github-child",
    "arrive-sibling",
    "arrive-other-github",
    "ask-settings",
  ]);
});

it("preserves route intent across generated arrival, loading and gate sequences", () => {
  const action = fc.constantFrom<Action>(
    "arrive-github",
    "arrive-github-child",
    "arrive-other-github",
    "arrive-late",
    "arrive-sibling",
    "arrive-vault",
    "load",
    "unload",
    "gate-on",
    "gate-off",
    "ask-gate",
    "ask-settings",
  );
  fc.assert(fc.property(fc.array(action, { maxLength: 30 }), scenario), {
    seed: 2542588,
    numRuns: 100,
  });
});
