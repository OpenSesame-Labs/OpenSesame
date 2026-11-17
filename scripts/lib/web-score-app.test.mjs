import { describe, expect, it, vi } from "vitest";
import { checkAppReady } from "./web-score-app.mjs";

describe("the OpenSesame interaction browser", () => {
  it.each([
    { noSandbox: false, enabled: true },
    { noSandbox: true, enabled: false },
  ])(
    "enforces the requested sandbox setting: $enabled",
    async ({ noSandbox, enabled }) => {
      const browserType = {
        launch: vi.fn().mockRejectedValue(new Error("stop before navigation")),
      };
      await expect(
        checkAppReady({
          chrome: "/test/chromium",
          targetUrl: new URL("https://example.test/OpenSesame/"),
          noSandbox,
          browserType,
        }),
      ).rejects.toThrow("stop before navigation");
      expect(browserType.launch).toHaveBeenLastCalledWith(
        expect.objectContaining({ chromiumSandbox: enabled }),
      );
    },
  );
});
