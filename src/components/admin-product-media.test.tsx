import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog } from "@radix-ui/react-dialog";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ProductEditor } from "@/components/admin";

// ADD IMAGE must never be a dead click: pasting a URL adds it to the media
// grid; an empty click explains itself instead of doing nothing.
describe("ProductEditor media", () => {
  async function renderEditor() {
    const rootRoute = createRootRoute({});
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <Dialog open><ProductEditor initial={undefined} onSaved={vi.fn()} onClose={vi.fn()} /></Dialog>,
    });
    const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    return render(<RouterProvider router={router} />);
  }
  it("adds a pasted URL to the media grid and clears the input", async () => {
    const { unmount } = await renderEditor();
    const input = screen.getByPlaceholderText("https://…");
    fireEvent.change(input, { target: { value: "https://example.com/shot.webp" } });
    const btn = screen.getByRole("button", { name: /add image/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(screen.getByText("2 · Media (1/6)")).toBeInTheDocument();
    expect(input).toHaveValue("");
    unmount();
  });
  it("always offers a device upload input (Supabase or demo mode)", async () => {
    const { unmount } = await renderEditor();
    expect(screen.getByLabelText("Upload product image")).toBeInTheDocument();
    unmount();
  });
});
