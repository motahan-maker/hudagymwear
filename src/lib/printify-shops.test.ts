import { describe, expect, it } from "vitest";
import {
  isIntegrationAdmin,
  parseShops,
  resolveShopSelection,
} from "../../supabase/functions/_shared/printify-core";

// The shop is the boundary for every other Printify call. Getting it wrong
// sends orders to the wrong shop, so these rules are tested explicitly.
describe("Printify shop discovery", () => {
  it("reads the shops the token can see", () => {
    const shops = parseShops([
      { id: 5432, title: "HUDA GYMWEAR", sales_channel: "API" },
      { id: 9876, title: "Another store", sales_channel: "disconnected" },
    ]);
    expect(shops).toEqual([
      { id: "5432", title: "HUDA GYMWEAR", sales_channel: "API" },
      { id: "9876", title: "Another store", sales_channel: "disconnected" },
    ]);
  });

  it("keeps a shop whose id is a string", () => {
    expect(parseShops([{ id: "abc", title: "Shop" }])[0]?.id).toBe("abc");
  });

  it("drops an entry that has no usable id, because it cannot be selected", () => {
    expect(parseShops([{ title: "No id" }, null, "nope", 42])).toEqual([]);
  });

  it("returns nothing for a body that is not a list", () => {
    expect(parseShops({ error: "Unauthenticated" })).toEqual([]);
    expect(parseShops(null)).toEqual([]);
  });

  it("tolerates a shop with no title or sales channel", () => {
    expect(parseShops([{ id: 1 }])[0]).toEqual({ id: "1", title: "", sales_channel: "" });
  });
});

describe("Printify shop selection", () => {
  const one = [{ id: "5432", title: "HUDA GYMWEAR", sales_channel: "API" }];
  const two = [
    { id: "5432", title: "HUDA GYMWEAR", sales_channel: "API" },
    { id: "9876", title: "Another store", sales_channel: "disconnected" },
  ];

  it("uses the only shop when there is exactly one", () => {
    const r = resolveShopSelection(one, "");
    expect(r.ok).toBe(true);
    expect(r.shop?.id).toBe("5432");
  });

  it("refuses to guess when several shops are visible", () => {
    const r = resolveShopSelection(two, "");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/choose the one for HUDA GYMWEAR/i);
  });

  it("uses an explicitly chosen shop", () => {
    const r = resolveShopSelection(two, "9876");
    expect(r.ok).toBe(true);
    expect(r.shop?.id).toBe("9876");
  });

  it("refuses a saved shop the token can no longer see", () => {
    const r = resolveShopSelection(one, "9999");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not visible to this token/i);
  });

  it("says so when no shop is attached to the token", () => {
    const r = resolveShopSelection([], "");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no shop is attached/i);
  });
});

describe("Printify integration authorization", () => {
  it("allows only an account whose role is admin", () => {
    expect(isIntegrationAdmin({ role: "admin" })).toBe(true);
    expect(isIntegrationAdmin({ role: "customer" })).toBe(false);
    expect(isIntegrationAdmin({ role: null })).toBe(false);
    expect(isIntegrationAdmin({})).toBe(false);
    expect(isIntegrationAdmin(null)).toBe(false);
    expect(isIntegrationAdmin(undefined)).toBe(false);
  });
});
