/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { SupportController } from "./session.js";
import { stubSupportController } from "./support-controller.test-support.js";
import { useSupportRouteSync } from "./use-support-route.js";

function Screen({ controller }: { controller: SupportController }) {
  useSupportRouteSync(controller, null);
  return <p data-testid="location">{useLocation().pathname}</p>;
}

afterEach(cleanup);

it("updates the support route when a capability registers or removes the current screen", () => {
  const route = "/settings/test-late-connection";
  const { support } = stubSupportController("/vault");
  const setRoute = vi.fn();
  support.setRoute = setRoute;
  render(
    <MemoryRouter initialEntries={[route]}>
      <Screen controller={support} />
    </MemoryRouter>,
  );
  expect(setRoute).toHaveBeenLastCalledWith("/settings");
  let revoke = () => {};
  act(() => {
    revoke = registerContributionForTest("tutorial-route", {
      id: route,
      title: "A connection that loads after arrival",
    });
  });
  expect(setRoute).toHaveBeenLastCalledWith(route);
  expect(screen.getByTestId("location").textContent).toBe(route);
  act(revoke);
  expect(setRoute).toHaveBeenLastCalledWith("/settings");
  expect(screen.getByTestId("location").textContent).toBe(route);
});

it.each(["/settings/connections/github", "/connections/github"])(
  "keeps %s as the guidance context before its optional route loads",
  (route) => {
    const { support } = stubSupportController("/vault");
    const setRoute = vi.fn();
    support.setRoute = setRoute;
    render(
      <MemoryRouter initialEntries={[route]}>
        <Screen controller={support} />
      </MemoryRouter>,
    );
    expect(setRoute).toHaveBeenLastCalledWith(route);
    expect(screen.getByTestId("location").textContent).toBe(route);
  },
);
