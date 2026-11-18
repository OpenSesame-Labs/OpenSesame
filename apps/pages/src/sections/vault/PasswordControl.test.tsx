/** @vitest-environment jsdom */
import type { PasswordMethod } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordControl } from "./PasswordControl.js";

afterEach(() => cleanup());

function method(): PasswordMethod {
  return {
    id: "m1",
    type: "password",
    secret: "current-secret-value",
    generator: {
      id: "rules",
      length: 20,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
      minDigits: 0,
      minSymbols: 0,
    },
    pepper: false,
    changedAt: "2026-10-27T00:00:00.000Z",
  };
}

function renderControl() {
  const onEdit = vi.fn<(next: PasswordMethod) => void>();
  render(
    <PasswordControl
      method={method()}
      onEdit={onEdit}
      options={{
        open: false,
        controls: "m1-options",
        onToggle: () => undefined,
      }}
    />,
  );
  return onEdit;
}

describe("PasswordControl generate key", () => {
  it("generates a new local draft without queuing a provider reset", async () => {
    const onEdit = renderControl();
    await userEvent.click(
      screen.getByRole("button", { name: "Generate another password" }),
    );
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[0].secret).not.toBe("current-secret-value");
  });
});
