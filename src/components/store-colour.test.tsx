import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { StoreProvider, useStore } from "@/components/store";
import { lineColour } from "@/lib/bag";
import { getProduct } from "@/lib/catalog";

// The colour a shopper picks is part of the line they buy. Losing it means the
// order is produced in the wrong colour, so it is protected here: the bag line
// must carry the colour that was chosen, not the product's default.
describe("bag colour", () => {
  beforeEach(() => window.localStorage.clear());

  async function renderShell() {
    const rootRoute = createRootRoute({});
    function Probe() {
      const { bag, add } = useStore();
      return (
        <div>
          <span data-testid="bag">{JSON.stringify(bag)}</span>
          <button type="button" onClick={() => add("sculpt-seamless-leggings", "M", "Soft Taupe")}>
            add taupe
          </button>
          <button type="button" onClick={() => add("sculpt-seamless-leggings", "M")}>
            add default
          </button>
          <button type="button" onClick={() => add("sculpt-seamless-leggings", "M", "Onyx Black")}>
            add black
          </button>
        </div>
      );
    }
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <StoreProvider>
          <Probe />
        </StoreProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    return render(
      <RouterProvider router={router} />,
    );
  }

  it("stores the colour that was chosen, not the product default", async () => {
    const { unmount } = await renderShell();
    fireEvent.click(screen.getByText("add taupe"));
    const bag = JSON.parse(screen.getByTestId("bag").textContent ?? "[]");
    expect(bag).toHaveLength(1);
    expect(bag[0].colour).toBe("Soft Taupe");
    expect(bag[0].size).toBe("M");
    unmount();
  });

  it("keeps the same product in two colours as two separate lines", async () => {
    const { unmount } = await renderShell();
    fireEvent.click(screen.getByText("add taupe"));
    fireEvent.click(screen.getByText("add black"));
    const bag = JSON.parse(screen.getByTestId("bag").textContent ?? "[]");
    expect(bag).toHaveLength(2);
    expect(bag.map((l: { colour: string }) => l.colour).sort()).toEqual(["Onyx Black", "Soft Taupe"]);
    unmount();
  });

  it("merges a repeat of the same product, size and colour", async () => {
    const { unmount } = await renderShell();
    fireEvent.click(screen.getByText("add taupe"));
    fireEvent.click(screen.getByText("add taupe"));
    const bag = JSON.parse(screen.getByTestId("bag").textContent ?? "[]");
    expect(bag).toHaveLength(1);
    expect(bag[0].quantity).toBe(2);
    unmount();
  });

  it("falls back to the product default colour when none is given", async () => {
    const { unmount } = await renderShell();
    fireEvent.click(screen.getByText("add default"));
    const bag = JSON.parse(screen.getByTestId("bag").textContent ?? "[]");
    expect(bag[0].colour).toBe(getProduct("sculpt-seamless-leggings")?.colour);
    unmount();
  });

  it("treats a bag saved before colours were tracked as the product default", () => {
    // A legacy line has no colour of its own. It must still resolve to the
    // product default rather than to an empty colour, so it renders and merges
    // with a newly added line for the same piece.
    const product = getProduct("sculpt-seamless-leggings");
    expect(lineColour({ id: "x", size: "M", quantity: 1 }, product)).toBe(product?.colour);
    expect(lineColour({ id: "x", size: "M", colour: "Soft Taupe", quantity: 1 }, product)).toBe("Soft Taupe");  });
});
