/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { LIVE_TARGETS } from "@opensesame/app-core/tutorial/registry/live-catalog.js";
import { isMountedGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useLiveShareGuideTarget } from "./use-live-share-guide.js";

afterEach(cleanup);

it("binds the control only while its live capability declares the target", () => {
  function Button() {
    return (
      <button type="button" ref={useLiveShareGuideTarget()}>
        Share
      </button>
    );
  }
  render(<Button />);
  expect(isMountedGuideTarget("shell.share")).toBe(false);
  const descriptor = LIVE_TARGETS[0];
  if (!descriptor) throw new Error("missing share target");
  let revoke = () => {};
  act(() => {
    revoke = registerContributionForTest("tutorial-target", descriptor);
  });
  expect(isMountedGuideTarget("shell.share")).toBe(true);
  act(() => revoke());
  expect(isMountedGuideTarget("shell.share")).toBe(false);
});
