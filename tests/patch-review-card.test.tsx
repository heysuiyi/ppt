// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatchReviewCard } from "../app/renderer/src/components/PatchReviewCard";

afterEach(cleanup);

describe("PatchReviewCard", () => {
  it("exposes disclosure state while revealing and hiding the remaining diff lines", () => {
    render(
      <PatchReviewCard
        patch={{
          patchId: "patch-1",
          threadId: "thread-1",
          targetPath: "brief.md",
          summary: "Update brief",
          contentBefore: "Before",
          contentAfter: Array.from({ length: 10 }, (_, index) => `After ${index + 1}`).join("\n"),
        }}
        busy={false}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    const disclosure = screen.getByRole("button", { expanded: false });
    expect(screen.queryByText(/After 10/)).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByRole("button", { expanded: true })).toBe(disclosure);
    expect(screen.getByText(/After 10/)).not.toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByRole("button", { expanded: false })).toBe(disclosure);
    expect(screen.queryByText(/After 10/)).toBeNull();
  });
});
