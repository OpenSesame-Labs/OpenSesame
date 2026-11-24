/** @vitest-environment jsdom */

import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeMcpClassification } from "@opensesame/app-core/lib/native-mcp-profile.js";
import { nativeOAuthGuard } from "@opensesame/app-core/lib/native-oauth-session.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useFlashNotice } from "../useFlashNotice.js";
import { NativeMcpTools } from "./NativeMcpTools.js";
import { installConnectorIntegration } from "./native-connector-integration.test-support.js";
import {
  discoveryFixture,
  within,
} from "./native-mcp-discover-owner.test-support.js";
import {
  advertisedArguments,
  nativeMcpToolsFixture,
} from "./native-mcp-tools.test-support.js";

describe("integration", () => {
  installConnectorIntegration();

  function ActualMcpPanel({
    actual,
    disabled = false,
  }: {
    actual: Awaited<ReturnType<typeof nativeMcpToolsFixture>>;
    disabled?: boolean;
  }) {
    const [view, setView] = useState(actual.view);
    const [flash, setFlash] = useState<Flash | null>(null);
    useFlashNotice(flash, view.connectionId, "Adobe");
    return (
      <NativeMcpTools
        view={view}
        controller={actual.controller}
        onChanged={(next) => {
          if (next) setView(next);
        }}
        onFlash={setFlash}
        disabled={disabled}
      />
    );
  }

  it("shows actual required and nested argument rules before sending a provider tool call", async () => {
    const actual = await nativeMcpToolsFixture();
    render(<ActualMcpPanel actual={actual} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Discover MCP tools" }),
    );
    const action = "provider.search: Search published provider records";
    await userEvent.click(
      await screen.findByText(action, { selector: "summary" }),
    );
    expect(screen.getByText("query, filter")).toBeTruthy();
    const guidance = screen.getByLabelText("Advertised argument schema");
    expect(JSON.parse(guidance.textContent ?? "null")).toEqual(
      advertisedArguments,
    );
    expect(guidance.textContent).toContain('"published"');
    expect(guidance.textContent).toContain('"boolean"');
    expect(actual.methods).not.toContain("tools/call");
    await userEvent.click(
      screen.getByText("Advertised argument schema", { selector: "summary" }),
    );
    expect(guidance.closest("details")).toHaveProperty("open", true);
    await userEvent.click(screen.getByRole("button", { name: action }));
    const message =
      "Enter arguments that match this tool’s advertised input schema.";
    expect(await screen.findByRole("img", { name: message })).toBeTruthy();
    await waitFor(() =>
      expect(listNotices()).toContainEqual(
        expect.objectContaining({
          id: `connector:${actual.view.connectionId}`,
          tone: "err",
          body: message,
        }),
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(actual.methods).not.toContain("tools/call");
    const argumentsValue = { query: "design", filter: { published: true } };
    fireEvent.change(screen.getByLabelText("Tool arguments (JSON object)"), {
      target: { value: JSON.stringify(argumentsValue) },
    });
    await userEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() =>
      expect(screen.getByText("Actual provider tool result")).toBeTruthy(),
    );
    expect(
      actual.methods.filter((method) => method === "tools/call"),
    ).toHaveLength(1);
    const ToolCall = z.object({
      method: z.literal("tools/call"),
      params: z.object({
        name: z.literal("provider.search"),
        arguments: z.object({
          query: z.string(),
          filter: z.object({ published: z.boolean() }),
        }),
      }),
    });
    const calls = [];
    for (const request of actual.fixture.requests) {
      if (request.method !== "POST" || !request.url.endsWith("/mcp")) continue;
      const call = ToolCall.safeParse(JSON.parse(await request.text()));
      if (call.success) calls.push(call.data);
    }
    expect(calls[0]?.params.arguments).toEqual(argumentsValue);
  });

  it("blocks new MCP starts while disabled and keeps selected tool arguments for re-enable", async () => {
    const actual = await nativeMcpToolsFixture();
    const mounted = render(<ActualMcpPanel actual={actual} />);
    const discover = () =>
      screen.getByRole("button", { name: "Discover MCP tools" });
    await userEvent.click(discover());
    const action = "provider.search: Search published provider records";
    await userEvent.click(
      await screen.findByText(action, { selector: "summary" }),
    );
    const argumentsValue = JSON.stringify({
      query: "design",
      filter: { published: true },
    });
    fireEvent.change(screen.getByLabelText("Tool arguments (JSON object)"), {
      target: { value: argumentsValue },
    });
    const requests = actual.fixture.requests.length;
    const methods = [...actual.methods];
    mounted.rerender(<ActualMcpPanel actual={actual} disabled />);
    expect(discover()).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: action })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByLabelText("Tool arguments (JSON object)").closest("fieldset"),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByLabelText("Tool arguments (JSON object)"),
    ).toHaveProperty("value", argumentsValue);
    expect(screen.getByText("query, filter")).toBeTruthy();
    await userEvent.click(discover());
    await userEvent.click(screen.getByRole("button", { name: action }));
    const form = screen.getByRole("button", { name: action }).closest("form");
    if (!form) throw new Error("Missing actual MCP tool form");
    fireEvent.submit(form);
    expect(actual.fixture.requests).toHaveLength(requests);
    expect(actual.methods).toEqual(methods);
    mounted.rerender(<ActualMcpPanel actual={actual} />);
    expect(
      screen.getByLabelText("Tool arguments (JSON object)"),
    ).toHaveProperty("value", argumentsValue);
    await userEvent.click(screen.getByRole("button", { name: action }));
    await screen.findByText("Actual provider tool result");
    expect(
      actual.methods.filter((method) => method === "tools/call"),
    ).toHaveLength(1);
  });
});

describe("owner integration", () => {
  installConnectorIntegration();
  function props(
    actual: Awaited<ReturnType<typeof discoveryFixture>>["actual"],
  ) {
    return {
      view: actual.view,
      controller: actual.controller,
      onFlash: vi.fn(),
      onChanged: vi.fn(),
    };
  }
  async function rename(id: string) {
    const record = loadNativeConnectorRecord(id);
    if (!record) throw new Error("Missing actual sealed connector row.");
    await updateNativeConnector(
      id,
      nativeOAuthGuard(record),
      nativeMcpClassification(record.configuration),
      (current) => {
        current.configuration.displayName = "New committed owner";
        return current;
      },
    );
    const view = readNativeConnector(id);
    if (!view) throw new Error("Missing replacement actual row.");
    return view;
  }
  it.each([
    "unmount",
    "disabled",
    "controller",
    "revision",
    "lock",
    "cold-row",
  ])(
    "withdraws held actual MCP discovery on %s with physical TLS close before two seconds and no late callback",
    async (reason) => {
      const wire = await discoveryFixture();
      const actual = wire.actual;
      const initial = props(actual);
      const invoke = vi.spyOn(actual.controller, "invoke");
      const mounted = render(<NativeMcpTools {...initial} />);
      try {
        await userEvent.click(
          screen.getByRole("button", { name: "Discover MCP tools" }),
        );
        await within(wire.state.entered.promise);
        const caller = invoke.mock.calls[0]?.[2];
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(wire.state.physicallyClosed).toBe(false);
        const start = performance.now();
        if (reason === "unmount") mounted.unmount();
        if (reason === "disabled")
          mounted.rerender(<NativeMcpTools {...initial} disabled />);
        if (reason === "controller")
          mounted.rerender(
            <NativeMcpTools
              {...initial}
              controller={{ ...actual.controller }}
            />,
          );
        if (reason === "revision") {
          const view = await rename(actual.view.connectionId);
          expect(view.revision).toBeGreaterThan(actual.view.revision);
          mounted.rerender(<NativeMcpTools {...initial} view={view} />);
        }
        if (reason === "lock")
          await act(async () => vaultStore.lock({ recordLastVault: false }));
        if (reason === "cold-row") {
          await actual.fixture.reload();
          const view = actual.controller.load();
          if (!view)
            throw new Error("Missing cold restored actual connection row.");
          mounted.rerender(
            <NativeMcpTools
              {...initial}
              view={view}
              controller={{ ...actual.controller }}
            />,
          );
        }
        await within(wire.state.closed.promise);
        expect(performance.now() - start).toBeLessThan(2000);
        expect(invoke).toHaveBeenCalledWith(
          "mcp.tools.list",
          {},
          expect.any(AbortSignal),
        );
        expect(caller?.aborted).toBe(true);
        await act(async () => {
          wire.release();
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(initial.onChanged).not.toHaveBeenCalled();
        expect(initial.onFlash).not.toHaveBeenCalled();
        expect(screen.queryByText(/Owned discovery server ·/)).toBeNull();
        expect(wire.state.errors).toEqual([]);
      } finally {
        cleanup();
        await wire.close();
      }
    },
  );
  it("consumes actual advertised discovery after a held response and refreshes only its live owner", async () => {
    const wire = await discoveryFixture();
    const initial = props(wire.actual);
    render(<NativeMcpTools {...initial} />);
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Discover MCP tools" }),
      );
      await within(wire.state.entered.promise);
      await act(async () => wire.release());
      await screen.findByText("Owned discovery server · 1 tools");
      expect(
        screen.getByText("provider.search: Search owned discovery records", {
          selector: "summary",
        }),
      ).toBeTruthy();
      expect(initial.onChanged).toHaveBeenCalledTimes(1);
      expect(initial.onFlash).not.toHaveBeenCalled();
      expect(wire.state.methods).toContain("initialize");
      expect(wire.state.methods).toContain("tools/list");
    } finally {
      cleanup();
      await wire.close();
    }
  });
  it.each([401, 500])(
    "keeps active provider HTTP%s errors visible and refreshes the active connection",
    async (status) => {
      const wire = await discoveryFixture();
      wire.state.status = status;
      wire.state.hold = false;
      const initial = props(wire.actual);
      render(<NativeMcpTools {...initial} />);
      try {
        await userEvent.click(
          screen.getByRole("button", { name: "Discover MCP tools" }),
        );
        await waitFor(() => expect(initial.onFlash).toHaveBeenCalledTimes(1));
        expect(initial.onFlash.mock.calls[0]?.[0].tone).toBe("err");
        expect(initial.onChanged).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(/Owned discovery server ·/)).toBeNull();
      } finally {
        cleanup();
        await wire.close();
      }
    },
  );
});
