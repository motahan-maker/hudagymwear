import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AdminCategories } from "@/components/admin";

// ADD CATEGORY must never be a dead click: empty/duplicate submits explain
// themselves inline, valid submits add the row.
describe("AdminCategories", () => {
  async function renderPage() {
    const rootRoute = createRootRoute({});
    const route = createRoute({ getParentRoute: () => rootRoute, path: "/", component: AdminCategories });
    const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    return render(<RouterProvider router={router} />);
  }
  it("adds a typed category to the list on submit", async () => {
    const { unmount } = await renderPage();
    const input = screen.getByLabelText("New category name");
    fireEvent.change(input, { target: { value: "Swimwear" } });
    fireEvent.click(screen.getByRole("button", { name: /add category/i }));
    expect(screen.getByText("Swimwear")).toBeInTheDocument();
    unmount();
  });
  it("shows an inline error on empty submit instead of doing nothing", async () => {
    const { unmount } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /add category/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/2\+ characters/);
    unmount();
  });
  it("shows an inline error for duplicate names", async () => {
    const { unmount } = await renderPage();
    const input = screen.getByLabelText("New category name");
    fireEvent.change(input, { target: { value: "leggings" } });
    fireEvent.click(screen.getByRole("button", { name: /add category/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/);
    unmount();
  });
});
