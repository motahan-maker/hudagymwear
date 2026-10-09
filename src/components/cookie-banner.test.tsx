import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { StoreProvider, CookieBanner } from "@/components/store";

// ACCEPT COOKIES reportedly hangs: clicking must persist + dismiss the banner.
describe("CookieBanner", () => {
  beforeEach(() => window.localStorage.clear());
  async function renderShell() {
    const rootRoute = createRootRoute({});
    const route = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <CookieBanner /> });
    const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    return render(<RouterProvider router={router} />);
  }
  it("accepting stores consent and dismisses the banner", async () => {
    const { unmount } = await renderShell();
    const btn = screen.getByRole("button", { name: /accept all/i });
    fireEvent.click(btn);
    expect(window.localStorage.getItem("huda.consent.v1")).toContain('"preferences":true');
    expect(screen.queryByRole("region", { name: /cookie consent/i })).not.toBeInTheDocument();
    unmount();
  });
  it("essential-only stores consent and dismisses the banner", async () => {
    const { unmount } = await renderShell();
    fireEvent.click(screen.getByRole("button", { name: /essential only/i }));
    expect(window.localStorage.getItem("huda.consent.v1")).toContain('"preferences":false');
    expect(screen.queryByRole("region", { name: /cookie consent/i })).not.toBeInTheDocument();
    unmount();
  });
});
