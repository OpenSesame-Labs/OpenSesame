import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import { afterEach, expect, it, vi } from "vitest";
import { showFirstVisitNotice } from "./first-visit-notice.js";

afterEach(clearNotices);

it("does not count an offer as answered when notices are cleared", () => {
  const answer = vi.fn();
  showFirstVisitNotice({
    id: "first-visit:test",
    title: "Tutorial",
    body: "Start the tutorial.",
    start: vi.fn(),
    answer,
  });
  clearNotices();
  expect(answer).not.toHaveBeenCalled();
});
