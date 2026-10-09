import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dialog } from "@radix-ui/react-dialog";
import { DiscountEditor } from "@/components/admin";

// Regression test: every control of the rebuilt discount form must render
// (Code, type segmented control, value, limits, both dates, active switch).
describe("DiscountEditor", () => {
  function renderEditor() {
    return render(
      <Dialog open>
        <DiscountEditor
          initial={{ code: "WELCOME10", kind: "percent", value: 10, minSpend: 50, maxUses: null, uses: 3, active: true }}
          onSaved={vi.fn()}
        />
      </Dialog>,
    );
  }

  it("renders all fields including Ends date and active switch", () => {
    const { unmount } = renderEditor();
    expect(screen.getByText("Code")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /discount type/i })).toBeInTheDocument();
    expect(screen.getByText("Min. spend (£)")).toBeInTheDocument();
    expect(screen.getByText("Usage limit")).toBeInTheDocument();
    expect(screen.getByText("Starts")).toBeInTheDocument();
    expect(screen.getByText("Ends")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /discount active/i })).toBeInTheDocument();
    unmount();
  });

  it("shows the live preview and the save button", () => {
    const { unmount } = renderEditor();
    expect(screen.getByText(/gives 10% off/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save code/i })).toBeInTheDocument();
    unmount();
  });
});
