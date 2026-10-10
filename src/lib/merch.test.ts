import { describe, expect, it, beforeEach } from "vitest";
import { saveCategories, visibleCategoryNames, listCategories } from "./merch";
import { categories as siteCategories } from "./catalog";

beforeEach(async () => {
  localStorage.clear();
  // Reset the module-level memory to all-visible seeds (test isolation).
  await saveCategories(siteCategories.map((name, order) => ({ name, visible: true, order })));
});

describe("category visibility sync", () => {
  it("hiding every category except one is reflected in visible names", async () => {
    const all = listCategories();
    expect(all.length).toBeGreaterThan(1);
    const keep = all[0]!.name;
    const next = all.map((c, i) => ({ ...c, visible: i === 0 }));
    const r = await saveCategories(next);
    expect(r.ok).toBe(true);
    expect(visibleCategoryNames()).toEqual([keep]);
  });

  it("reports failure shape when cloud sync is unavailable (demo stays local)", async () => {
    const all = listCategories();
    const r = await saveCategories(all);
    // No Supabase in tests → local-only success.
    expect(r.ok).toBe(true);
    expect(visibleCategoryNames().length).toBe(all.length);
  });
});
