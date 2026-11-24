// @vitest-environment jsdom
import { resetSpeechSeams } from "@opensesame/app-core/lib/command-bar/speech.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBar } from "./CommandBar.js";
import { CommandBarVoice } from "./command-bar-voice.js";
import { installFakeSpeech } from "./command-bar-voice.test-support.js";
import { expectInTray, inTray } from "./tray.test-support.js";

describe("command-bar-voice", () => {
  const mount = (setNotice: (text: string | null) => void = vi.fn()) =>
    render(
      <CommandBarVoice
        setValue={vi.fn()}
        setNotice={setNotice}
        run={vi.fn(async () => {})}
        busy={false}
      />,
    );

  async function pressAndRelease() {
    fireEvent.click(screen.getByRole("button", { name: "Start listening" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop listening" }),
    );
  }

  describe("CommandBarVoice failures", () => {
    afterEach(() => {
      cleanup();
      resetSpeechSeams();
    });

    it("sends a blocked microphone to the tray and marks the mic key", async () => {
      const { engines } = installFakeSpeech(true);
      mount();
      fireEvent.click(screen.getByRole("button", { name: "Start listening" }));
      act(() => engines[0]?.fail("not-allowed"));
      await expectInTray("Microphone permission is blocked for this site.");
      expect(
        screen.getByRole("img", {
          name: "Microphone permission is blocked for this site.",
        }),
      ).toBeTruthy();
      expect(document.querySelector(".status-mark")?.className).toContain(
        "status-mark--err",
      );
    });

    it("sends an engine that never started to the tray, with a mark", async () => {
      installFakeSpeech(false);
      mount();
      await pressAndRelease();
      await expectInTray("Speech engine never started");
      expect(
        screen.getByRole("img", { name: /^Speech engine never started/ }),
      ).toBeTruthy();
    });

    it("keeps the speak-again guidance in the status line, not the tray", async () => {
      installFakeSpeech(true);
      const setNotice = vi.fn();
      mount(setNotice);
      await pressAndRelease();
      await waitFor(() =>
        expect(setNotice).toHaveBeenCalledWith(
          "No speech heard. Allow the mic, speak while it is lit, then tap again.",
        ),
      );
      expect(inTray(/No speech heard/)).toBe(false);
      expect(screen.queryByRole("img")).toBeNull();
    });
  });
});

describe("live", () => {
  let release: (() => void) | null = null;

  afterEach(() => {
    cleanup();
    release?.();
    release = null;
    resetSpeechSeams();
  });

  describe("CommandBar with voice input", () => {
    it("keeps one live push-to-talk while interim words re-render the bar", () => {
      const { engines } = installFakeSpeech(true);
      release = registerContributionForTest("command-assist", {
        id: "test-model",
        order: 0,
        interpret: async () => ({ source: "none", reason: "Empty command." }),
        Voice: CommandBarVoice,
      });
      render(
        <MemoryRouter>
          <CommandBar />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Start listening" }));
      act(() => engines[0]?.hear("go to"));
      act(() => engines[0]?.hear("go to vault"));
      expect(
        screen.getByRole<HTMLInputElement>("combobox", { name: "Command" })
          .value,
      ).toBe("go to vault");
      expect(engines).toHaveLength(1);
      expect(engines[0]?.aborted).toBe(false);
    });
  });
});
