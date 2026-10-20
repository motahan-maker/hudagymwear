import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AdminPrintify } from "@/components/printify-admin";

// The Printify screen must refuse in demo mode, not fake it: a "saved" token or
// a "sent" order that only lives in localStorage would be a lie about money.
// This is the whole admin surface when no Supabase project is configured, so it
// is also the shape the store owner sees first.
describe("AdminPrintify in demo mode", () => {
  async function renderPage() {
    const rootRoute = createRootRoute({});
    const route = createRoute({ getParentRoute: () => rootRoute, path: "/", component: AdminPrintify });
    const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    return render(<RouterProvider router={router} />);
  }

  it("explains that fulfilment is unavailable instead of pretending to work", async () => {
    const { unmount } = await renderPage();
    expect(screen.getByRole("heading", { name: "Printify" })).toBeInTheDocument();
    expect(screen.getByText("Fulfilment is unavailable here")).toBeInTheDocument();
    expect(screen.getByText(/deliberately no demo version/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect Supabase/i)).toBeInTheDocument();
    unmount();
  });

  it("offers no token field, no catalogue and no send buttons", async () => {
    const { unmount } = await renderPage();
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sync catalogue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test connection/i })).not.toBeInTheDocument();
    unmount();
  });
});
