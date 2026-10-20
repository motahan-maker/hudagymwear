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

// Migration 0010 puts a real money system behind this store: Printify charges the
// merchant card, and the token that authorises it lives in the database. These are
// the invariants that keep that power contained — checked as SQL text because the
// file itself was executed against a real Postgres (PGlite) before it shipped.
describe("migration 0010 — printify", () => {
  const sql = read("0010_printify.sql");

  /** One function, from its declaration to the end of its body. */
  function body(name: string): string {
    const start = sql.indexOf(`create or replace function public.${name}`);
    expect(start, `${name} is defined`).toBeGreaterThan(-1);
    const open = sql.indexOf("as $$", start);
    const close = sql.indexOf("$$;", open);
    return sql.slice(start, close === -1 ? undefined : close);
  }

  it("is additive: it never drops, truncates or rewrites what the store already has", () => {
    expect(sql).not.toMatch(/\bdrop table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete from public\.orders\b/i);
    expect(sql).not.toMatch(/alter table public\.orders/i);
    expect(sql).not.toMatch(/\bdrop function\b/i);
    // Everything it creates is re-runnable, which is what makes a safe re-deploy.
    expect(sql).toMatch(/create table if not exists public\.printify_settings/i);
    expect(sql).toMatch(/create or replace function/i);
  });

  it("keeps the token and webhook secret out of reach of every browser role", () => {
    expect(sql).toMatch(/alter table public\.printify_credentials enable row level security/i);
    // RLS enabled with zero policies is the point: any anon/authenticated SELECT
    // gets an empty set rather than an error that would confirm the row exists.
    expect(sql).not.toMatch(/create policy[\s\S]{0,200}?on public\.printify_credentials/i);
    expect(sql).toMatch(/revoke all on table public\.printify_credentials from anon, authenticated/i);
    expect(sql).toMatch(/grant all on table public\.printify_credentials to service_role/i);
    expect(sql).not.toMatch(/grant[\s\S]{0,120}?to anon/i);
    expect(sql).not.toMatch(/grant[\s\S]{0,120}?to public/i);
  });

  it("pins search_path on every function it defines", () => {
    for (const name of ["set_printify_cod_policy", "claim_printify_fulfilment", "release_printify_fulfilment",
      "record_printify_event", "mark_printify_event", "apply_printify_shipment", "record_printify_order_status"]) {
      expect(body(name), name).toMatch(/security definer set search_path = public/i);
    }
  });

  it("authorises the privileged RPCs inside postgres, not in the admin UI", () => {
    // The claim is SECURITY DEFINER and callable by any signed-in staff member,
    // so it must re-check is_admin() itself against auth.uid().
    expect(body("claim_printify_fulfilment")).toMatch(/if not public\.is_admin\(\) then/i);
    expect(body("set_printify_cod_policy")).toMatch(/if not public\.is_admin\(\) then/i);
    expect(sql).toMatch(/revoke all on function public\.claim_printify_fulfilment\(text\)\s+from public, anon/i);
    // Event ingestion has no user session at all: service_role and nobody else.
    for (const fn of ["record_printify_event", "mark_printify_event", "apply_printify_shipment", "record_printify_order_status"]) {
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, "i"));
      expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`, "i"));
    }
  });

  it("makes the COD switch cost an explicit, attributed policy note", () => {
    const fn = body("set_printify_cod_policy");
    expect(fn).toMatch(/if p_allowed then/i);
    expect(fn).toMatch(/char_length\(v_note\) < 20/i);
    expect(fn).toMatch(/cod_policy_by = v_uid/i);
    expect(fn).toMatch(/cod_policy_at = now\(\)/i);
    // Turning it OFF is one click and needs no note — the safe direction is cheap.
    expect(fn).toMatch(/set cod_fulfilment_allowed = false/i);
    // And the note is a statement about OUR arrangements, never a claim that
    // Printify collects cash from the customer.
    expect(sql).toMatch(/does not imply printify collects cash/i);
  });

  it("gates a claim on payment, holds the row, and stores the money split", () => {
    const fn = body("claim_printify_fulfilment");
    expect(fn).toMatch(/from public\.orders where id = p_order_id for update/i);
    expect(fn).toMatch(/payment = 'bank' and[\s\S]{0,120}payment_status <> 'Paid'/i);
    expect(fn).toMatch(/payment = 'cod' and not v_settings\.cod_fulfilment_allowed/i);
    expect(fn).toMatch(/'awaiting_payment'/i);
    expect(fn).toMatch(/state = 'submitting'/i);
    expect(fn).toMatch(/claim_expires_at = now\(\) \+ interval/i);
    // Both map axes must match: size alone once produced the nearest colour.
    expect(fn).toMatch(/vm\.size\s*=\s*btrim/i);
    expect(fn).toMatch(/vm\.colour\s*=\s*btrim/i);
    // The order id IS the Printify external_id, which is the idempotency key.
    expect(fn).toMatch(/'external_id', p_order_id/i);
    expect(fn).not.toMatch(/gen_random_uuid\(\)[\s\S]{0,80}'external_id'/i);
  });

  it("cannot release a claim that another worker already took", () => {
    const fn = body("release_printify_fulfilment");
    // Distinct-from, not `<>`: a null token must not match a null argument.
    expect(fn).toMatch(/claim_token is distinct from p_claim_token/i);
    expect(fn).toMatch(/claim no longer valid/i);
  });

  it("lets a verified shipment event be the only writer of the customer timeline", () => {
    // Nothing else in this migration touches orders.status / orders.timeline.
    const writers = ["set_printify_cod_policy", "claim_printify_fulfilment", "release_printify_fulfilment",
      "record_printify_event", "mark_printify_event", "record_printify_order_status"]
      .filter((n) => /update public\.orders/i.test(body(n)));
    expect(writers).toEqual([]);
    expect(body("apply_printify_shipment")).toMatch(/update public\.orders/i);
    // Only the two shipment statuses exist, and only forwards.
    const fn = body("apply_printify_shipment");
    expect(fn).toMatch(/p_status = 'shipped'/i);
    expect(fn).toMatch(/p_status = 'delivered'/i);
    expect(fn).toMatch(/status must be shipped or delivered/i);
    expect(fn).toMatch(/v_order\.status = 'Cancelled'/i);
    expect(fn).toMatch(/already shipped|already delivered/i);
  });

  it("deduplicates a retried delivery instead of applying it twice", () => {
    const fn = body("record_printify_event");
    expect(fn).toMatch(/on conflict \(event_id\) do nothing/i);
    expect(fn).toMatch(/get diagnostics v_rows = row_count/i);
    expect(fn).toMatch(/'duplicate', true/i);
  });

  it("starts switched off, with no automatic production", () => {
    expect(sql).toMatch(/enabled\s+boolean not null default false/i);
    expect(sql).toMatch(/auto_send_to_production boolean not null default false/i);
    expect(sql).toMatch(/cod_fulfilment_allowed boolean not null default false/i);
  });

  it("treats a missing variant-map row as 'not sold through Printify'", () => {
    expect(sql).toMatch(/primary key \(external_product_id, size, colour\)/i);
    expect(sql).toMatch(/absence of a row means the combination is not sold through printify/i);
    // Provider cost is stored in minor units and is never a sell price.
    expect(sql).toMatch(/cost_cents\s+integer not null default 0 check \(cost_cents >= 0\)/i);
    expect(sql).not.toMatch(/update public\.products[\s\S]{0,200}?(price|sale_price)/i);
  });
});

// Migrations 0011-0013 tighten the Printify contract and the trust boundary
// between the browser and the integration. These are the invariants that keep
// a catalogue sync from becoming a way to change a retail price, and that keep
// a browser from rewriting the fulfilment state machine.
describe("migrations 0011-0013", () => {
  it("0011 is additive: it adds columns and indexes, and drops no data", () => {
    const sql = read("0011_printify_contract.sql");
    expect(sql).not.toMatch(/\bdrop table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete from\b/i);
    expect(sql).not.toMatch(/alter table public\.orders\b/i);
    expect(sql).not.toMatch(/alter table public\.products\b/i);
  });

  it("0011 keeps the option definitions the variant ids refer to", () => {
    const sql = read("0011_printify_contract.sql");
    // A shop product's variant carries option IDS; the labels live on the
    // parent product. Without this column every variant reads as unmapped.
    expect(sql).toMatch(/add column if not exists options jsonb/i);
    expect(sql).toMatch(/add column if not exists image_urls text\[\]/i);
    // The cost currency is a fact to be recorded, not an assumption.
    expect(sql).toMatch(/add column if not exists cost_currency text not null default ''/i);
    // A mapping an admin reviewed must survive a re-sync.
    expect(sql).toMatch(/add column if not exists source text not null default 'auto'/i);
    expect(sql).toMatch(/check \(source in \('auto', 'manual'\)\)/i);
  });

  it("0011 indexes the column the webhook receiver looks up", () => {
    const sql = read("0011_printify_contract.sql");
    expect(sql).toMatch(
      /create unique index if not exists order_fulfilment_printify_order_idx[\s\S]{0,200}printify_order_id/i,
    );
  });

  it("0012 stops the order trigger taking a price from the browser", () => {
    const sql = read("0012_storefront_integrity.sql");
    const fn = sql.slice(
      sql.indexOf("create or replace function public.recalculate_order_v2"),
      sql.indexOf("$$;", sql.indexOf("create or replace function public.recalculate_order_v2")),
    );
    // A product that is not in the catalogue has no trusted price, so the
    // order is refused rather than priced from the request.
    expect(fn).toMatch(/if not found then/i);
    expect(fn).toMatch(/no longer available/i);
    expect(fn).not.toMatch(/it ->> 'price'/i);
    // The colour is part of the line the Printify claim joins on.
    expect(fn).toMatch(/this colour is not available/i);
    // And the trigger is actually swapped over.
    expect(sql).toMatch(/execute function public\.recalculate_order_v2\(\)/i);
    // The old function stays for the documented rollback.
    expect(sql).toMatch(/recalculate_order_legacy|recalculate_order\(\)/i);
  });

  it("0012 keeps the discount counter from being rolled back", () => {
    const sql = read("0012_storefront_integrity.sql");
    expect(sql).toMatch(/create or replace function public\.guard_discount_uses\(\)/i);
    expect(sql).toMatch(/if new\.uses < old\.uses then/i);
  });

  it("0013 stops the browser writing the Printify tables directly", () => {
    const sql = read("0013_printify_permissions.sql");
    expect(sql).toMatch(
      /revoke insert, update, delete on table[\s\S]{0,400}public\.order_fulfilment[\s\S]{0,200}public\.printify_settings[\s\S]{0,200}from anon, authenticated/i,
    );
    // The one write an admin still needs goes through an authorised RPC.
    expect(sql).toMatch(/create or replace function public\.set_printify_variant_override\(/i);
    expect(sql).toMatch(/if not public\.is_admin\(\) then/i);
    expect(sql).toMatch(/grant execute on function public\.set_printify_variant_override\([^)]*\) to authenticated/i);
  });

  it("0013 does not grant the service role a claim it can never make", () => {
    const sql = read("0013_printify_permissions.sql");
    // The claim checks is_admin(), which reads auth.uid(); a service-role call
    // has no session and can only ever be refused.
    expect(sql).toMatch(/revoke all on function public\.claim_printify_fulfilment\(text\) from public, anon, service_role/i);
    expect(sql).toMatch(/grant execute on function public\.claim_printify_fulfilment\(text\) to authenticated;/i);
  });

  it("no new migration can drop a table or rewrite the orders history", () => {
    for (const f of ["0011_printify_contract.sql", "0012_storefront_integrity.sql", "0013_printify_permissions.sql"]) {
      const sql = read(f);
      expect(sql, f).not.toMatch(/\bdrop table\b/i);
      expect(sql, f).not.toMatch(/\btruncate\b/i);
      expect(sql, f).not.toMatch(/alter table public\.orders\b/i);
      expect(sql, f).not.toMatch(/\bdelete from public\.orders\b/i);
    }
  });
});
// Migration 0014 exists so the admin can see which shops the token can reach
// after a reload, without an API call on every page load. It is a cache, and
// it must never be the thing that decides which shop is used.
describe("migration 0014 - printify shop discovery", () => {
  const sql = read("0014_printify_shop_discovery.sql");

  it("is additive and drops nothing", () => {
    expect(sql).not.toMatch(/\bdrop table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/alter table public\.orders\b/i);
    expect(sql).not.toMatch(/alter table public\.products\b/i);
    expect(sql).toMatch(/add column if not exists last_shops jsonb not null default '\[\]'::jsonb/i);
  });

  it("stores only the shop identity, never a credential", () => {
    // The cached value is a shop identity: an id, a title and a sales channel.
    expect(sql).toMatch(/sales_channel/i);
    expect(sql).toMatch(/\btitle\b/i);
    expect(sql).not.toMatch(/api_token/i);
    expect(sql).not.toMatch(/webhook_secret/i);
    expect(sql).not.toMatch(/bearer/i);
  });
});