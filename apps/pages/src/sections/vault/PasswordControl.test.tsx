/** @vitest-environment jsdom */

import { observeGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
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

  it("explains how to recover when the pepper replaces the entire generated password", async () => {
    const onEdit = vi.fn<(next: PasswordMethod) => void>();
    const control = (value: PasswordMethod) => (
      <PasswordControl
        method={value}
        onEdit={onEdit}
        options={{ open: true, controls: "m1-options", onToggle: () => {} }}
      />
    );
    const empty = { ...method(), pepper: true, pepperAt: "0:" };
    const view = render(control(empty));
    const generate = screen.getByRole("button", {
      name: "Generate another password",
    });
    await userEvent.click(generate);
    expect(onEdit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("img", { name: /Set the pepper position to end/ }),
    ).toBeTruthy();
    view.rerender(control({ ...empty, pepperAt: "end" }));
    await userEvent.click(generate);
    expect(onEdit).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("img", { name: /Set the pepper position to end/ }),
    ).toBeNull();
  });

  it("advances a waiting tutorial only after a new password is generated", async () => {
    const valid = method();
    if (valid.generator.id !== "rules") throw new Error("Expected rules");
    const invalid: PasswordMethod = {
      ...valid,
      generator: {
        ...valid.generator,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
      },
    };
    const onEdit = vi.fn<(next: PasswordMethod) => void>();
    const control = (value: PasswordMethod) => (
      <PasswordControl
        method={value}
        onEdit={onEdit}
        options={{ open: false, controls: "m1-options", onToggle: () => {} }}
      />
    );
    const view = render(control(valid));
    const generate = () =>
      screen.getByRole("button", { name: "Generate another password" });

    // A generation from before the tutorial started must not satisfy it.
    await userEvent.click(generate());
    expect(onEdit).toHaveBeenCalledTimes(1);
    view.rerender(control(invalid));
    const abort = new AbortController();
    const advanced = vi.fn();
    const waiting = observeGuideTarget(
      "editor.generate-password",
      "activate",
      abort.signal,
    ).then(advanced);

    await userEvent.click(generate());
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(advanced).not.toHaveBeenCalled();
    expect(
      screen.getByRole("img", { name: /Could not generate a password/ }),
    ).toBeTruthy();

    view.rerender(control(valid));
    await userEvent.click(generate());
    await waiting;
    expect(advanced).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("img", { name: /Could not generate a password/ }),
    ).toBeNull();
  });
});
