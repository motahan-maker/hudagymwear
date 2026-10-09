import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f: string) => readFileSync(path.join(root, "supabase", "migrations", f), "utf8");

// Regression test for "permission denied for function is_admin" on guest
// PLACE ORDER: the recalculate_order() trigger reads products/discounts,
// whose RLS calls is_admin() — anon MUST hold EXECUTE (it can only ever
// return false for anon, so policies still enforce correctly).
describe("supabase migrations", () => {
  it("0005 grants is_admin() to anon without opening it to public", () => {
    expect(existsSync(path.join(root, "supabase", "migrations", "0005_fix.sql"))).toBe(true);
    const sql = read("0005_fix.sql");
    expect(sql).toMatch(/grant execute on function public\.is_admin\(\) to anon/i);
    expect(sql).not.toMatch(/grant execute on function public\.is_admin\(\) to public/i);
  });
  it("0003 still revokes is_admin() from public (defense in depth)", () => {
    const sql = read("0003_security.sql");
    expect(sql).toMatch(/revoke all on function public\.is_admin\(\)/i);
  });
  it("trigger helpers are not directly callable via RPC", () => {
    const sql = read("0005_fix.sql");
    for (const fn of ["recalculate_order", "restock_on_cancel", "handle_new_user", "block_privilege_escalation"]) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(\\)`, "i"));
    }
  });
});
