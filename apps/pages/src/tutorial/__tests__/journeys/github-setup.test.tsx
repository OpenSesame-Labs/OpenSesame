/** @vitest-environment jsdom */

import type { Connection } from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  forgetSessionAnswers,
  guidanceSeams,
  loadGuidance,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import { fakeAgentReplanning } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "../../../sections/connections/SettingsPage.js";
import { makeConnection } from "../../../sections/connections/section-fixtures.test-support.js";
import { firstVisitSeams } from "../../first-visit/FirstVisitOffer.js";
import {
  finishTutorial,
  nextStep,
  renderJourney,
  resetJourney,
  tutorialCard,
} from "./harness.jsx";

const originalGuidance = { ...guidanceSeams };
const originalDelay = firstVisitSeams.delayMs;
let stored: string | null = null;
beforeEach(() => {
  stored = null;
  guidanceSeams.read = () => stored;
  guidanceSeams.write = (value) => {
    stored = value;
  };
  firstVisitSeams.delayMs = 20;
  forgetSessionAnswers();
  setGuidanceMode("auto");
});
afterEach(() => {
  resetJourney();
  forgetSessionAnswers();
  Object.assign(guidanceSeams, originalGuidance);
  firstVisitSeams.delayMs = originalDelay;
});

function GithubPage({
  connection = null,
  loading = false,
}: {
  connection?: Connection | null;
  loading?: boolean;
}) {
  const provider = catalogProvider("github");
  const location = useLocation();
  if (!provider) throw new Error("Missing GitHub provider");
  return (
    <>
      <output data-testid="route">{location.pathname}</output>
      <ConnectorSettingsPage
        provider={provider}
        providerId="github"
        connection={connection}
        connections={connection ? [connection] : []}
        loading={loading}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </>
  );
}

function LoadingGithubPage({ resolved }: { resolved: Connection | null }) {
  const [loading, setLoading] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setLoading(false)}>
        Finish loading
      </button>
      <GithubPage connection={loading ? null : resolved} loading={loading} />
    </>
  );
}

it.each(["/settings/connections/github", "/connections/github"])(
  "starts the first-visit tour on %s without leaving or changing it",
  async (route) => {
    const journey = renderJourney(fakeAgentReplanning([]), {
      at: route,
      screen: <GithubPage />,
    });
    expect(screen.getByRole("radio", { name: "GitHub App" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "GitHub backup" }),
    ).toHaveProperty("disabled", true);
    await tutorialCard();
    await waitFor(() =>
      expect(journey.focused()).toEqual(["connections.github.method"]),
    );
    await nextStep(journey.user);
    await nextStep(journey.user);
    await waitFor(() =>
      expect(journey.focused()).toEqual([
        "connections.github.method",
        "connections.github.backup",
      ]),
    );
    await nextStep(journey.user);
    await nextStep(journey.user);
    await finishTutorial(journey.user);
    expect(journey.navigations()).toEqual([]);
    expect(screen.getByTestId("route").textContent).toBe(route);
    expect(
      screen.getByRole("button", { name: "Create GitHub App" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "GitHub backup" }),
    ).toHaveProperty("disabled", true);
    expect(loadGuidance().tours).toContain("connection.github.setup");
  },
);

it("remembers when the person skips the offer and keeps setup available", async () => {
  setGuidanceMode("offer");
  const route = "/settings/connections/github";
  const journey = renderJourney(fakeAgentReplanning([]), {
    at: route,
    screen: <GithubPage />,
  });
  const offer = await screen.findByRole("complementary", {
    name: "Set up GitHub walkthrough",
  });
  expect(offer.closest("[data-first-visit-offer]")).not.toBeNull();
  expect(offer.closest(".toasts")).toBeNull();
  await journey.user.click(
    within(offer).getByRole("button", { name: "Not now" }),
  );
  expect(journey.navigations()).toEqual([]);
  expect(document.activeElement).toBe(
    screen.getByRole("radio", { name: "GitHub App" }),
  );
  expect(loadGuidance().tours).toContain("connection.github.setup");
  expect(
    screen.getByRole("button", { name: "Create GitHub App" }),
  ).toBeTruthy();
  resetJourney();
  forgetSessionAnswers();
  renderJourney(fakeAgentReplanning([]), { at: route, screen: <GithubPage /> });
  await waitFor(() =>
    expect(
      screen.queryByRole("complementary", {
        name: "Set up GitHub walkthrough",
      }),
    ).toBeNull(),
  );
  expect(screen.getByRole("radio", { name: "GitHub App" })).toBeTruthy();
});

it.each(["auto", "offer"] as const)(
  "does not offer the native setup tour for an imported Connect connection in %s mode",
  async (mode) => {
    setGuidanceMode(mode);
    const route = "/settings/connections/github/imported";
    const connection = makeConnection({
      connectionId: "imported",
      connectionRef: "connect://github/imported",
    });
    const journey = renderJourney(fakeAgentReplanning([]), {
      at: route,
      screen: <GithubPage connection={connection} />,
    });
    expect(screen.queryByRole("radio", { name: "GitHub App" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole("dialog", { name: /Tutorial:/ })).toBeNull();
    expect(
      screen.queryByRole("complementary", {
        name: "Set up GitHub walkthrough",
      }),
    ).toBeNull();
    expect(journey.navigations()).toEqual([]);
    expect(loadGuidance().tours).not.toContain("connection.github.setup");
  },
);

it.each(["auto", "offer"] as const)(
  "waits for a native GitHub page to finish loading before the %s guide",
  async (mode) => {
    setGuidanceMode(mode);
    const journey = renderJourney(fakeAgentReplanning([]), {
      at: "/settings/connections/github",
      screen: <LoadingGithubPage resolved={null} />,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole("dialog", { name: /Tutorial:/ })).toBeNull();
    expect(screen.queryByText("Set up GitHub.")).toBeNull();
    await journey.user.click(
      screen.getByRole("button", { name: "Finish loading" }),
    );
    if (mode === "auto") await tutorialCard();
    else
      await screen.findByRole("complementary", {
        name: "Set up GitHub walkthrough",
      });
    expect(journey.navigations()).toEqual([]);
  },
);

it("does not start a native tour while an imported connection is loading", async () => {
  const resolved = makeConnection({
    connectionId: "imported",
    connectionRef: "connect://github/imported",
  });
  const journey = renderJourney(fakeAgentReplanning([]), {
    at: "/settings/connections/github/imported",
    screen: <LoadingGithubPage resolved={resolved} />,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.queryByRole("dialog", { name: /Tutorial:/ })).toBeNull();
  await journey.user.click(
    screen.getByRole("button", { name: "Finish loading" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.queryByRole("dialog", { name: /Tutorial:/ })).toBeNull();
  expect(journey.navigations()).toEqual([]);
  expect(loadGuidance().tours).not.toContain("connection.github.setup");
});

it("starts the inline offer without leaving GitHub", async () => {
  setGuidanceMode("offer");
  const route = "/settings/connections/github";
  const journey = renderJourney(fakeAgentReplanning([]), {
    at: route,
    screen: <GithubPage />,
  });
  const offer = await screen.findByRole("complementary", {
    name: "Set up GitHub walkthrough",
  });
  await journey.user.click(
    within(offer).getByRole("button", { name: "Start tutorial" }),
  );
  await tutorialCard();
  await waitFor(() =>
    expect(journey.focused()).toEqual(["connections.github.method"]),
  );
  expect(journey.navigations()).toEqual([]);
  expect(screen.getByTestId("route").textContent).toBe(route);
});
