/** @vitest-environment jsdom */

import {
  isAiModelProvider,
  modelProtocolLabel,
} from "@opensesame/app-core/lib/ai-model-provider.js";
import {
  connectPlan,
  isRegistryPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  canonicalProviderId,
  catalogProvider,
} from "@opensesame/app-core/lib/connector-catalog.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectionRouteProvider } from "@opensesame/app-core/sections/connections/provider-route.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitToConsumer } from "../../lib/command-bar/search.js";
import { standInPrompt } from "../../lib/command-bar/search.test-support.js";
import {
  CatalogPanel,
  authKindLabel,
  catalogMethodLabel,
} from "./CatalogPanel.js";
import { API_FAMILIES, apiFamilyFor } from "./catalog-families.js";
import { curatedCatalogProviders } from "./catalog-selection.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./connect/native-connector-integration.test-support.js";
import { identityConnectionMethodLabel } from "./identity/identity-ui-values.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

describe("CatalogPanel", () => {
  // The catalog mounts `connections.catalog` and `.provider-picker`,
  // which `connectors.external` declares when it activates (ADR 0130).
  declareConnectionsTutorial();
  afterEach(cleanup);

  it("keeps browse-catalog tiles out of sequential Tab order", () => {
    const { container } = render(
      <MemoryRouter>
        <CatalogPanel providers={mergeVercelCatalog(getBundledProviders())} />
      </MemoryRouter>,
    );
    const tiles = [
      ...container.querySelectorAll<HTMLAnchorElement>("a.conn-tile__link"),
    ];
    expect(container.querySelectorAll(".conn-tile").length).toBeGreaterThan(0);
    expect(tiles.length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".conn-group__label")).toHaveLength(0);
    expect(
      container.querySelectorAll(".conn-tile__tags .conn-tag").length,
    ).toBeGreaterThan(0);
    const linearLink = container.querySelector<HTMLAnchorElement>(
      "#catalog-linear a.conn-tile__link",
    );
    expect(linearLink).toBeTruthy();
    expect(linearLink?.getAttribute("aria-describedby")).toBe(
      "catalog-linear-tags",
    );
    expect(container.querySelector("#catalog-linq")).toBeNull();
    expect(container.querySelector("#catalog-whoop")).toBeNull();
    for (const tile of tiles) expect(tile.tabIndex).toBe(-1);
    // Nothing leads to a page that does not exist: the catalog's own tiles are
    // its only links.
    expect(screen.queryByRole("link", { name: "Custom connector" })).toBeNull();
    const byoAi = container.querySelector("#catalog-byo-ai");
    // BYO AI has a complete configuration contract available to a guest.
    const byoAiLink = screen.getByRole("link", { name: "Connect BYO AI" });
    expect(byoAi?.querySelector("a")).toBe(byoAiLink);
    expect(byoAiLink.getAttribute("href")).toBe("/connections/byo-ai");
    expect(byoAiLink.getAttribute("aria-describedby")).toBe(
      "catalog-byo-ai-tags",
    );
    expect(byoAiLink.tabIndex).toBe(-1);
    const blocked = byoAi?.querySelector(".conn-tile__go title");
    expect(blocked).toBeNull();
    expect(byoAi?.textContent).not.toMatch(/Not connectable/);
  });

  it("puts BYO AI first and keeps partner tiles alphabetical", () => {
    const ids = new Set(["openai", "anthropic", "byo-ai"]);
    const { container } = render(
      <MemoryRouter>
        <CatalogPanel
          providers={getBundledProviders().filter((provider) =>
            ids.has(provider.id),
          )}
        />
      </MemoryRouter>,
    );
    const tiles = [...container.querySelectorAll(".conn-grid > .conn-tile")];
    expect(tiles[0]?.id).toBe("catalog-byo-ai");
    expect(
      tiles
        .map((tile) => tile.id)
        .filter((id) =>
          ["catalog-byo-ai", "catalog-anthropic", "catalog-openai"].includes(
            id,
          ),
        ),
    ).toEqual(["catalog-byo-ai", "catalog-anthropic", "catalog-openai"]);
    const byo = container.querySelector("#catalog-byo-ai");
    expect(byo?.querySelector("a")?.getAttribute("href")).toBe(
      "/connections/byo-ai",
    );
    expect(byo?.querySelector(".conn-tag--method")?.textContent).toBe(
      "Configuration",
    );
  });

  it("links the + button to the custom connector form", () => {
    render(
      <MemoryRouter>
        <CatalogPanel providers={mergeVercelCatalog(getBundledProviders())} />
      </MemoryRouter>,
    );
    const add = screen.getByRole("link", { name: "Add a custom connection" });
    expect(add.getAttribute("href")).toBe("/connections/custom-oidc");
  });
});

describe("search", () => {
  // The panel registers guide targets; a deployment that approved connections declares them.
  declareConnectionsTutorial();

  function provider(id: string, displayName: string): Provider {
    return {
      id,
      displayName,
      category: "developer",
      docsUrl: "https://example.invalid/docs",
      authKind: "oauth2_authorization_code",
      supportsRefresh: true,
      configured: true,
      autoConfigurable: false,
      missingConfig: [],
      callbackUrl: null,
      scopes: [],
      egress: { scheme: "https", authorities: [], pathPrefixes: [] },
      operations: [],
    };
  }

  let prompt = standInPrompt();
  beforeEach(() => {
    prompt = standInPrompt();
  });
  afterEach(() => {
    cleanup();
    prompt.stop();
  });

  describe("the connector catalog searched in the prompt", () => {
    it("Enter lands the keyboard on the first matching tile, and stays in the field when none match", () => {
      render(
        <MemoryRouter>
          <CatalogPanel
            providers={[
              provider("github", "GitHub"),
              provider("linear", "Linear"),
            ]}
          />
        </MemoryRouter>,
      );
      expect(screen.queryByLabelText("Search connectors")).toBeNull();
      act(() => prompt.type("/? linear"));
      expect(commitToConsumer()).toBe("took");
      expect(
        document.activeElement?.closest(".conn-tile")?.textContent,
      ).toContain("Linear");
      act(() => prompt.type("/? zzzz"));
      expect(commitToConsumer()).toBe("seen");
    });
  });
});

describe("actions integration", () => {
  declareConnectionsTutorial();
  installConnectorIntegration();

  it("offers actual configuration routes for compiled API protocols despite hosted CORS history", () => {
    connectorIntegration();
    render(
      <MemoryRouter>
        <CatalogPanel
          providers={[
            integrationProvider("linear"),
            integrationProvider("openai"),
          ]}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("link", { name: "Connect Linear" }).getAttribute("href"),
    ).toBe("/connections/linear");
    expect(
      screen.getByRole("link", { name: "Connect OpenAI" }).getAttribute("href"),
    ).toBe("/connections/openai");
    expect(
      screen.queryByRole("img", { name: "Provider blocks browsers" }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Desktop app required" }),
    ).toBeNull();
  });

  /**
   * A family tile links to the page of a row its family holds, whose "API
   * family" select reaches the rest (SettingsPage.family.test.tsx).
   */
  it("opens each family's tile on a page its route draws, in that family", () => {
    connectorIntegration();
    const providers = mergeVercelCatalog(getBundledProviders());
    render(
      <MemoryRouter>
        <CatalogPanel providers={providers} />
      </MemoryRouter>,
    );
    for (const family of API_FAMILIES) {
      const href = document
        .getElementById(`catalog-${encodeURIComponent(family.id)}`)
        ?.querySelector("a")
        ?.getAttribute("href");
      expect(href, family.id).toBeTruthy();
      const route = decodeURIComponent(href?.split("/").pop() ?? "");
      const page = connectionRouteProvider(providers, route);
      expect(page, `${family.id} opens ${route}`).not.toBeNull();
      expect(apiFamilyFor(page?.id ?? "")?.id, route).toBe(family.id);
    }
  });
});

describe("count integration", () => {
  declareConnectionsTutorial();
  afterEach(cleanup);
  it("counts the exact rendered merged-catalog tiles, including refused and unavailable entries", () => {
    const providers = mergeVercelCatalog(getBundledProviders());
    render(
      <MemoryRouter>
        <CatalogPanel providers={providers} />
      </MemoryRouter>,
    );
    const listed = curatedCatalogProviders(providers, {
      includeFeatured: true,
      includeFamilies: true,
    });
    const tiles = [...document.querySelectorAll("#catalog .conn-tile")];
    expect(tiles).toHaveLength(listed.length);
    expect(tiles.map((tile) => tile.id).sort()).toEqual(
      listed.map((row) => `catalog-${encodeURIComponent(row.id)}`).sort(),
    );
    expect(providers.length).toBeGreaterThan(listed.length);
    expect(tiles.length).toBeGreaterThan(0);
  });

  /**
   * A tile is a row of the one integration catalog (ADR 0139), or a service
   * Vercel's Connect registry lists (ADR 0147). A provider we researched
   * ourselves is a catalog row, so every target reads the same name, category,
   * auth and egress.
   */
  it("draws every tile from the integration catalog or Connect's registry", () => {
    render(
      <MemoryRouter>
        <CatalogPanel providers={mergeVercelCatalog(getBundledProviders())} />
      </MemoryRouter>,
    );
    const unlisted = [...document.querySelectorAll("#catalog .conn-tile")]
      .map((tile) => decodeURIComponent(tile.id.replace(/^catalog-/, "")))
      .filter(
        (id) => canonicalProviderId(id) === undefined && !isRegistryPlan(id),
      );
    expect(unlisted).toEqual([]);
  });
});

describe("methods integration", () => {
  declareConnectionsTutorial();
  afterEach(cleanup);
  it("keeps removed providers off the page while showing compiled protocols", () => {
    const providers = mergeVercelCatalog(getBundledProviders());
    render(
      <MemoryRouter>
        <CatalogPanel providers={providers} />
      </MemoryRouter>,
    );
    expect(document.getElementById("catalog-adobe")).toBeNull();
    expect(document.getElementById("catalog-datadog")).toBeNull();
    const linearProvider = providers.find(
      (provider) => provider.id === "linear",
    );
    if (!linearProvider) throw new Error("Missing Linear");
    expect(
      document
        .getElementById("catalog-linear")
        ?.querySelector(".conn-tile__kind")?.textContent,
    ).toBe(catalogMethodLabel(linearProvider));
  });
  it("uses compiled provider protocols across the full public catalog and keeps legacy feature labels", () => {
    for (const provider of mergeVercelCatalog(getBundledProviders())) {
      const identity = identityConnectionMethodLabel(provider.id);
      if (identity) {
        expect(catalogMethodLabel(provider)).toBe(identity);
        continue;
      }
      const plan = connectPlan(provider.id);
      if (!plan) {
        // A model provider's tile also says which API it speaks (ADR 0192).
        const protocol = isAiModelProvider(provider)
          ? ` · ${modelProtocolLabel(provider.id)}`
          : "";
        expect(catalogMethodLabel(provider)).toBe(
          `${authKindLabel(provider)}${protocol}`,
        );
        continue;
      }
      const label = catalogMethodLabel(provider);
      expect(label).not.toBe("Managed");
      for (const method of plan.methods) {
        if (method.kind === "mcp") expect(label).toContain("MCP");
        if (method.kind === "oauth" && method.preset)
          expect(label).toContain("OAuth");
        if (method.kind === "api-key" && method.preset)
          expect(label).toContain("API key");
      }
    }
    const provider = catalogProvider("better-auth");
    if (!provider) throw new Error("Missing legacy catalog provider");
    expect(catalogMethodLabel(provider)).toBe("Email/password · OIDC");
  });

  it("names compiled protocols before any connection target or native carrier exists", () => {
    const providers = mergeVercelCatalog(getBundledProviders());
    const labels = Object.fromEntries(
      providers.map((provider) => [provider.id, catalogMethodLabel(provider)]),
    );
    expect(labels.notion).toContain("API key");
    expect(labels.notion).not.toContain("API key (browser unavailable)");
    expect(labels.resend).toContain("API key");
    expect(labels.resend).not.toContain("API key (browser unavailable)");
    expect(labels.resend).toContain("OAuth");
    expect(labels.resend).not.toContain("browser unavailable");
    expect(labels.resend).toContain("MCP");
    expect(labels.adobe).toBe("MCP");
  });
});
