import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import {
  GATE_MESSAGE,
  PRINTIFY_BLOCKED_STATUSES,
  PRINTIFY_STATUSES,
  PRINTIFY_TOPICS,
  SITE_SIZES,
  buildSubmitOrderPayload,
  constantTimeEqual,
  costToPounds,
  derivedEventId,
  duplicateIsRecoverable,
  externalIdFor,
  hmacHex,
  interpretSubmitResponse,
  isoCountry,
  lineExternalId,
  marginBetween,
  mapVariants,
  matchSiteColour,
  normalizeEvent,
  normalizeSize,
  paymentGate,
  printifyShippingMethod,
  printifyStatusMeaning,
  productImageUrls,
  resolveEventId,
  splitOrderLines,
  uuidFromDigest,
  verifyWebhookSignature,
  type OrderLinePayload,
  type PrintifyVariant,
  type SiteAddress,
  type SiteOrderLine,
  type VariantMapRow,
} from "../../supabase/functions/_shared/printify-core";
import { WEBHOOK_TOPICS, printifyReady, variantColours, getStatus, getQueue, fulfil } from "./printify";

// ---------------------------------------------------------------------------
// This file is the only automated proof that the Printify rules hold:
// signatures, variant mapping, eligibility, and idempotency. It imports the
// shared module straight from supabase/functions/_shared — that file is written
// with no Deno APIs and no npm: specifiers precisely so the same code can be
// executed here. If it ever stops importing cleanly, the integration has become
// untestable and that is the signal to fix the module, not the test.
//
// jsdom has no SubtleCrypto; node's stands in. Same algorithm, not a stub —
// every assertion below exercises real HMAC and real SHA-256.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const mapRow = (over: Partial<VariantMapRow> = {}): VariantMapRow => ({
  size: "M", colour: "Black", printify_variant_id: 5001, sku: "", cost_cents: 9_900, available: true, ...over,
});
const line = (over: Partial<SiteOrderLine> = {}): SiteOrderLine => ({
  productId: "sculpt-seamless-leggings", name: "Sculpt Leggings", colour: "Black", size: "M", qty: 1, ...over,
});
const address = (over: Partial<SiteAddress> = {}): SiteAddress => ({
  firstName: "Huda", lastName: "Ali", street: "12 High Street", city: "London",
  postcode: "E1 6AN", country: "United Kingdom", phone: "+447700900123", ...over,
});
const payloadLine = (over: Partial<OrderLinePayload> = {}): OrderLinePayload => ({
  external_product_id: "654321", printify_variant_id: 5001, quantity: 1, line_external_id: "HG-2050:0", ...over,
});

// ---------------------------------------------------------------------------
// 1. Webhook authenticity
// ---------------------------------------------------------------------------
describe("Printify webhook signatures", () => {
  const SECRET = "whsec_0f1e2d3c4b5a6978";
  const BODY = JSON.stringify({ id: "b1a2c3d4-0000-4000-8000-000000000001", type: "order:updated" });

  it("accepts the HMAC of the exact raw body", async () => {
    const signature = `sha256=${await hmacHex(SECRET, BODY)}`;
    expect(await verifyWebhookSignature(BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a delivery whose body was altered after signing", async () => {
    const signature = `sha256=${await hmacHex(SECRET, BODY)}`;
    // One extra space is enough — which is why verification runs on the raw
    // bytes and never on a re-serialised object.
    expect(await verifyWebhookSignature(`${BODY} `, signature, SECRET)).toBe(false);
    expect(await verifyWebhookSignature(BODY.replace("order:updated", "order:created"), signature, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different webhook secret", async () => {
    const signature = `sha256=${await hmacHex("whsec_some_other_secret", BODY)}`;
    expect(await verifyWebhookSignature(BODY, signature, SECRET)).toBe(false);
  });

  it("refuses everything when no secret is configured", async () => {
    // An unconfigured verifier is an open door, not a disabled feature.
    const signature = `sha256=${await hmacHex(SECRET, BODY)}`;
    expect(await verifyWebhookSignature(BODY, signature, "")).toBe(false);
    expect(await verifyWebhookSignature(BODY, signature, undefined as unknown as string)).toBe(false);
  });

  it("refuses a missing or malformed signature header", async () => {
    for (const header of [undefined, null, "", "not-a-signature", "sha256=deadbeef", `sha256=${"z".repeat(64)}`, (await hmacHex(SECRET, BODY))]) {
      expect(await verifyWebhookSignature(BODY, header, SECRET)).toBe(false);
    }
  });

  it("compares full strings without short-circuiting on length", () => {
    expect(constantTimeEqual("sha256=aa", "sha256=aa")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("sha256=aa", "sha256=ab")).toBe(false);
    expect(constantTimeEqual("sha256=aa", "sha256=a")).toBe(false);
    expect(constantTimeEqual("sha256=a", "sha256=aa")).toBe(false);
    expect(constantTimeEqual("anything", 42 as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Event normalisation + dedup identity
// ---------------------------------------------------------------------------
describe("Printify event envelope", () => {
  const shipmentEvent = (over: Record<string, unknown> = {}) => ({
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    type: "order:shipment:created",
    created_at: "2026-10-09T09:00:00Z",
    resource: {
      type: "shipment",
      id: "55501212",
      data: {
        order_id: "987654",
        shipped_at: "2026-10-09T08:55:00Z",
        carrier: { code: "DPD", tracking_number: "TRK-777", tracking_url: "https://track.example/777" },
      },
    },
    ...over,
  });

  it("reads tracking out of the documented carrier object", () => {
    const ev = normalizeEvent(shipmentEvent());
    expect(ev.topic).toBe("order:shipment:created");
    expect(ev.movement).toBe("shipped");
    expect(ev.carrier).toBe("DPD");
    expect(ev.tracking_number).toBe("TRK-777");
    expect(ev.tracking_url).toBe("https://track.example/777");
    expect(ev.occurred_at).toBe("2026-10-09T08:55:00Z");
    // Shipment events carry the shipment id in resource.id; the order lives in
    // the body. Taking resource.id here would drop every tracking update.
    expect(ev.printify_order_id).toBe("987654");
    expect(ev.resource_id).toBe("55501212");
  });

  it("reads tracking from the flat shipment shape too", () => {
    const ev = normalizeEvent({
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", type: "order:shipment:delivered", created_at: "2026-10-11T10:00:00Z",
      resource: { type: "shipment", id: "1", data: { order_id: "987654", carrier: "Evri", tracking_number: "H0123", tracking_url: "https://evri/H0123" } },
    });
    expect(ev.movement).toBe("delivered");
    expect(ev.carrier).toBe("Evri");
    expect(ev.tracking_number).toBe("H0123");
    expect(ev.tracking_url).toBe("https://evri/H0123");
    expect(ev.printify_order_id).toBe("987654");
    // No delivered_at in the body: the envelope timestamp stands in.
    expect(ev.occurred_at).toBe("2026-10-11T10:00:00Z");
  });

  it("only shipment topics can move the customer timeline", () => {
    const orderUpdate = normalizeEvent({
      id: "11111111-2222-4333-8444-555555555555", type: "order:updated", created_at: "2026-10-09T09:00:00Z",
      resource: { type: "order", id: "987654", data: { status: "in-production" } },
    });
    expect(orderUpdate.movement).toBe("");
    expect(orderUpdate.printify_status).toBe("in-production");
    expect(orderUpdate.printify_order_id).toBe("987654");
    expect(orderUpdate.tracking_number).toBe("");

    // A delivered_at without its own shipment topic must not invent 'shipped'.
    const odd = normalizeEvent({ type: "order:updated", resource: { id: "9", data: { delivered_at: "2026-10-10T00:00:00Z" } } });
    expect(odd.movement).toBe("delivered");
    const created = normalizeEvent({ type: "order:created", resource: { id: "9", data: {} } });
    expect(created.movement).toBe("");
  });

  it("survives a garbage payload without throwing", () => {
    for (const junk of [null, undefined, "text", 42, [], { resource: "not-an-object" }]) {
      const ev = normalizeEvent(junk);
      expect(ev.topic).toBe("");
      expect(ev.movement).toBe("");
      expect(ev.event_id).toBe("");
    }
  });

  it("uses Printify's uuid when it is one, and refuses to invent a shape", () => {
    expect(derivedEventId({ id: "7C9E6679-7425-40de-944b-e07fc1f90ae7" }, "order:updated"))
      .toBe("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    expect(derivedEventId({ id: "evt_123" }, "order:updated")).toBe("");
    expect(derivedEventId({}, "order:updated")).toBe("");
  });

  it("derives a stable v4-shaped id for a delivery that has none", async () => {
    const body = { type: "order:updated", resource: { id: "987654", data: { status: "fulfilled" } } };
    const ev = normalizeEvent(body);
    const first = await resolveEventId(ev, body);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // A retried delivery of the same event must map to the same row.
    expect(await resolveEventId(ev, JSON.parse(JSON.stringify(body)))).toBe(first);
    // A different status is a different event.
    expect(await resolveEventId(ev, { ...body, resource: { id: "987654", data: { status: "canceled" } } })).not.toBe(first);
  });

  it("coerces any digest into a structurally valid uuid", () => {
    for (const digest of ["a".repeat(64), "abc", "not-hex-at-all", ""]) {
      const id = uuidFromDigest(digest);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(uuidFromDigest("f".repeat(64))).toBe(uuidFromDigest("F".repeat(64)));
  });

  it("keeps the topics the browser offers inside what the receiver understands", () => {
    const known = new Set<string>(PRINTIFY_TOPICS);
    for (const topic of WEBHOOK_TOPICS) expect(known.has(topic)).toBe(true);
    // Tracking is the whole point of registering webhooks; both must be offered.
    expect(WEBHOOK_TOPICS).toContain("order:shipment:created");
    expect(WEBHOOK_TOPICS).toContain("order:shipment:delivered");
    expect(WEBHOOK_TOPICS.length).toBeLessThanOrEqual(PRINTIFY_TOPICS.length);
  });
});

// ---------------------------------------------------------------------------
// 3. Variant mapping
// ---------------------------------------------------------------------------
describe("Printify variant mapping", () => {
  it("normalises the size spellings providers actually use", () => {
    expect(normalizeSize("Medium")).toBe("M");
    expect(normalizeSize("XL")).toBe("XL");
    expect(normalizeSize("2 XL")).toBe("XXL");
    expect(normalizeSize("2xl")).toBe("XXL");
    expect(normalizeSize("Extra-Large")).toBe("XL");
    expect(normalizeSize("One Size")).toBe("One size");
    expect(normalizeSize("  s  ")).toBe("S");
    // An unknown label echoes back uppercased and is then rejected by SITE_SIZES.
    expect(normalizeSize("taille unique premium")).toBe("TAILLE UNIQUE PREMIUM");
    expect(normalizeSize("")).toBe("");
    expect((SITE_SIZES as string[]).includes(normalizeSize("2 XL"))).toBe(true);
  });

  it("matches colours case-insensitively and returns the website spelling", () => {
    const site = ["Black", "Sand Beige", "Cherry Red"];
    expect(matchSiteColour("black", site)).toBe("Black");
    expect(matchSiteColour(" sand ", site)).toBe("Sand Beige");
    expect(matchSiteColour("teal", site)).toBe("");
    expect(matchSiteColour("", site)).toBe("");
  });

  it("maps a size + colour variant onto a trusted row", () => {
    const { supported, unsupported } = mapVariants([
      { id: 5001, sku: "LGH-M-BLK", cost: 9_950, is_enabled: true, is_available: true, options: [{ name: "Size", value: "M" }, { name: "Colour", value: "black" }] },
    ], [], ["Black", "Sand"]);
    expect(unsupported).toEqual([]);
    expect(supported).toEqual([
      { size: "M", colour: "Black", printify_variant_id: 5001, sku: "LGH-M-BLK", cost_cents: 9_950, available: true },
    ]);
  });

  it("resolves a shop product's integer option ids against the parent product", () => {
    // This is the shape Printify actually returns for a shop product: the
    // variant carries option IDS, and the parent product carries the labels
    // and which axis each option belongs to.
    const productOptions = [
      { name: "Sizes", type: "size", values: [{ id: 1189, title: "M" }, { id: 1190, title: "L" }] },
      { name: "Colours", type: "color", values: [{ id: 1191, title: "Onyx Black" }] },
    ];
    const { supported, unsupported } = mapVariants([
      { id: 33719, sku: "LGH-M-BLK", cost: 9_950, is_enabled: true, is_available: true, options: [1189, 1191] },
    ], productOptions, ["Onyx Black", "Soft Taupe"]);
    expect(unsupported).toEqual([]);
    expect(supported).toEqual([
      { size: "M", colour: "Onyx Black", printify_variant_id: 33719, sku: "LGH-M-BLK", cost_cents: 9_950, available: true },
    ]);
  });

  it("reports an option id the parent product does not define instead of guessing", () => {
    const productOptions = [
      { name: "Sizes", type: "size", values: [{ id: 1189, title: "M" }] },
      { name: "Colours", type: "color", values: [{ id: 1191, title: "Onyx Black" }] },
    ];
    const { supported, unsupported } = mapVariants([
      { id: 1, options: [1189, 1191, 4242] },
    ], productOptions, ["Onyx Black"]);
    expect(supported).toEqual([]);
    expect(unsupported[0]?.reason).toMatch(/unsupported options/);
  });

  it("keeps the provider cost in minor units and never rounds it into a price", () => {
    const { supported } = mapVariants([
      { id: 1, cost: 12_345, options: [{ name: "Size", value: "S" }, { name: "Color", value: "Black" }] },
      { id: 2, options: [{ name: "Size", value: "S" }, { name: "Color", value: "Black" }] },
      { id: 3, cost: -50, options: [{ name: "Size", value: "S" }, { name: "Color", value: "Black" }] },
    ], [], ["Black"]);
    expect(supported.map((r) => r.cost_cents)).toEqual([12_345, 0, 0]);
    expect(supported.map((r) => r.available)).toEqual([true, true, true]);
  });

  it("sends everything the site model cannot represent to review, not to sale", () => {
    const variants: PrintifyVariant[] = [
      { id: 10, options: [{ name: "Size", value: "M" }, { name: "Colour", value: "Black" }, { name: "Fit", value: "Relaxed" }] },
      { id: 11, is_enabled: false, options: [{ name: "Size", value: "M" }, { name: "Colour", value: "Black" }] },
      { id: 12, options: [{ name: "Size", value: "4XL" }, { name: "Colour", value: "Black" }] },
      { id: 13, options: [{ name: "Size", value: "M" }, { name: "Colour", value: "Neon Magenta" }] },
      { id: 14, options: [{ name: "Colour", value: "Black" }] },
      // A variant with no id at all cannot be submitted, whatever else it says.
      { options: [{ name: "Size", value: "M" }] } as unknown as PrintifyVariant,
    ];
    const { supported, unsupported } = mapVariants(variants, [], ["Black"]);
    expect(supported).toEqual([]);
    expect(unsupported.map((u) => u.variant_id)).toEqual([10, 11, 12, 13, 14, -1]);
    expect(unsupported.map((u) => u.reason)).toEqual([
      "unsupported options: Fit: Relaxed",
      "variant disabled on Printify",
      'size "4XL" is not sold on this site',
      'colour "Neon Magenta" has no website equivalent',
      "no size axis recognised",
      "variant has no id",
    ]);
  });

  it("absorbs an unlabelled axis only when it is genuinely a size or a colour", () => {
    // Some apparel leaves the option NAME blank. 'S' is a size and 'Cherry Red'
    // is a colour; a third label is a dimension the site cannot sell in.
    const twoAxes = mapVariants([{ id: 1, options: [{ name: "", value: "S" }, { name: "", value: "Cherry Red" }] }], [], ["Cherry Red"]);
    expect(twoAxes.supported).toEqual([
      { size: "S", colour: "Cherry Red", printify_variant_id: 1, sku: "", cost_cents: 0, available: true },
    ]);
    expect(twoAxes.unsupported).toEqual([]);

    const threeAxes = mapVariants([{ id: 2, options: [{ name: "", value: "S" }, { name: "", value: "Cherry Red" }, { name: "", value: "Relaxed" }] }], [], ["Cherry Red"]);
    expect(threeAxes.supported).toEqual([]);
    expect(threeAxes.unsupported[0]?.reason).toBe("unsupported options: unnamed option: Relaxed");
  });

  it("marks a variant unavailable on Printify so fulfilment cannot pick it", () => {
    const { supported } = mapVariants([
      { id: 1, is_available: false, options: [{ name: "Size", value: "L" }, { name: "Colour", value: "Black" }] },
    ], [], ["Black"]);
    expect(supported[0]?.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Eligibility: which lines go, which stay, and when an order may go at all
// ---------------------------------------------------------------------------
describe("Printify fulfilment eligibility", () => {
  const map: Record<string, VariantMapRow[]> = {
    "sculpt-seamless-leggings": [mapRow({ size: "M", colour: "Black" }), mapRow({ size: "L", colour: "Black", available: false })],
    "huda-sculpt-zip-hoodie": [mapRow({ size: "S", colour: "Ivory", printify_variant_id: 6001 })],
  };

  it("sends only lines the stored map can vouch for", () => {
    const items = [
      line(),                                        // mapped and available
      line({ size: "L" }),                           // mapped but unavailable on Printify
      line({ colour: "Sand" }),                      // colour nobody imported
      line({ productId: "huda-sculpt-zip-hoodie", size: "S", colour: "Ivory" }),
      line({ productId: "handmade-hair-ribbon" }),   // not a Printify product at all
    ];
    const split = splitOrderLines(items, map);
    expect(split.printifyIndices).toEqual([0, 3]);
    expect(split.otherIndices).toEqual([1, 2, 4]);
  });

  it("keeps colour in the key, so a line can never be produced in the nearest colour", () => {
    const items = [line({ colour: "black" })]; // map holds "Black"; SQL compares exactly
    expect(splitOrderLines(items, map).printifyIndices).toEqual([]);
  });

  it("tolerates size spellings on both sides of the split", () => {
    const withAlias: Record<string, VariantMapRow[]> = { "sculpt-seamless-leggings": [mapRow({ size: "2XL" })] };
    expect(splitOrderLines([line({ size: "2 XL" })], withAlias).printifyIndices).toEqual([0]);
    expect(splitOrderLines([line({ size: "XXL" })], withAlias).printifyIndices).toEqual([0]);
  });

  it("holds back an order with no Printify lines instead of sending an empty one", () => {
    const split = splitOrderLines([line({ productId: "unknown" })], map);
    expect(split.printifyIndices).toEqual([]);
    expect(splitOrderLines([], map)).toEqual({ printifyIndices: [], otherIndices: [] });
  });

  it("blocks bank transfers until the existing approval workflow says Paid", () => {
    expect(paymentGate("bank", "Pending proof", true)).toBe("bank_unpaid");
    expect(paymentGate("bank", "Awaiting review", true)).toBe("bank_unpaid");
    expect(paymentGate("bank", "Paid", false)).toBe("allowed");
    expect(GATE_MESSAGE.bank_unpaid).toMatch(/not been approved/i);
  });

  it("blocks cash on delivery until a funding policy is on record", () => {
    expect(paymentGate("cod", "Cash on delivery", false)).toBe("cod_without_policy");
    expect(paymentGate("cod", "Cash on delivery", true)).toBe("allowed");
    // The policy note is about OUR off-platform arrangement, not Printify collecting cash.
    expect(GATE_MESSAGE.cod_without_policy).toMatch(/funding\/collection policy/i);
    expect(GATE_MESSAGE.cod_without_policy).not.toMatch(/printify will collect/i);
    expect(GATE_MESSAGE.allowed).toBe("");
  });

  it("refuses a payment method the integration does not understand", () => {
    expect(paymentGate("card", "Paid", true)).toBe("unknown");
    expect(paymentGate("", "", true)).toBe("unknown");
    expect(GATE_MESSAGE.unknown).toMatch(/unrecognised/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency — the property that stops a second production order
// ---------------------------------------------------------------------------
describe("Printify submission idempotency", () => {
  it("keys the external id off the order, never off the attempt", () => {
    const first = externalIdFor("HG-2050");
    const retry = externalIdFor("HG-2050");
    expect(first).toBe(retry);
    expect(first).toBe("HG-2050");
    expect(first).not.toBe(externalIdFor("HG-2051"));
    // Line ids are positional and stable, so a retry reconciles the same lines.
    expect(lineExternalId("HG-2050", 0)).toBe("HG-2050:0");
    expect(lineExternalId("HG-2050", 2)).toBe("HG-2050:2");
    const seen = new Set([0, 1, 2, 3].map((i) => lineExternalId("HG-2050", i)));
    expect(seen.size).toBe(4);
  });

  it("reads a 2xx with an id as submitted", () => {
    expect(interpretSubmitResponse(201, { id: "987654" })).toEqual({ kind: "submitted", printifyOrderId: "987654" });
    expect(interpretSubmitResponse(200, { data: { id: 987654 } })).toEqual({ kind: "submitted", printifyOrderId: "987654" });
    // A dropped-response retry: Printify returns nothing useful, we still know
    // the order id from the envelope, so it is recorded rather than re-sent.
    expect(interpretSubmitResponse(200, {}, "987654")).toEqual({ kind: "submitted", printifyOrderId: "987654" });
  });

  it("refuses to mark success without any order id at all", () => {
    const out = interpretSubmitResponse(200, {});
    expect(out.kind).toBe("rejected");
    expect(out.kind === "rejected" && out.error).toMatch(/no id/i);
  });

  it("treats a duplicate external_id as the same order, not a failure", () => {
    const dup = interpretSubmitResponse(409, { id: "987654" });
    expect(dup).toEqual({ kind: "duplicate", printifyOrderId: "987654" });
    expect(interpretSubmitResponse(400, { code: 8503, id: "987654" })).toEqual({ kind: "duplicate", printifyOrderId: "987654" });
    expect(duplicateIsRecoverable(dup)).toBe(true);
    // A duplicate we cannot reconcile must not be silently counted as sent.
    expect(duplicateIsRecoverable(interpretSubmitResponse(409, {}))).toBe(false);
    expect(duplicateIsRecoverable(interpretSubmitResponse(201, { id: "1" }))).toBe(false);
  });

  it("separates a transient network failure from a real rejection", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(interpretSubmitResponse(status, {}).kind).toBe("transient");
    }
    expect(interpretSubmitResponse(503, { message: "cloudflare timeout" })).toEqual({ kind: "transient", status: 503, error: "cloudflare timeout" });
    const rejected = interpretSubmitResponse(400, { message: "invalid variant", code: 2001 });
    expect(rejected).toEqual({ kind: "rejected", status: 400, error: "invalid variant", code: 2001 });
    expect(interpretSubmitResponse(401, {}).kind).toBe("rejected");
  });

  it("treats an unreachable Printify as transient, not as a rejected payload", () => {
    // Status 0 is a timeout or a dropped connection: nothing was rejected, so
    // telling the admin the payload is wrong would send them to fix the wrong
    // thing. Retrying is safe because external_id is the idempotency key.
    const outcome = interpretSubmitResponse(0, { message: "Printify could not be reached." });
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") expect(outcome.status).toBe(0);
  });

  it("reads production mockups from the image objects Printify returns", () => {
    // `product.images` is a list of OBJECTS, not a list of URL strings. Read
    // as strings it yields nothing, and the mirrored catalogue has no imagery.
    expect(
      productImageUrls([
        { src: "https://images.printify.com/mockup/a.jpg", variant_ids: [33719], position: "front" },
        { src: "https://images.printify.com/mockup/b.jpg", variant_ids: [33719], position: "back" },
      ]),
    ).toEqual(["https://images.printify.com/mockup/a.jpg", "https://images.printify.com/mockup/b.jpg"]);
    expect(productImageUrls([])).toEqual([]);
    expect(productImageUrls(undefined)).toEqual([]);
  });

  it("builds the current create-order payload and nothing else", () => {
    const body = buildSubmitOrderPayload({
      orderId: "HG-2050",
      email: "huda@example.co.uk",
      address: address(),
      shippingMethod: "UK Standard delivery",
      lines: [payloadLine(), payloadLine({ printify_variant_id: 5002, quantity: 2, line_external_id: "HG-2050:1" })],
    });
    // Only the Printify subset is ever passed in; the rest of the order stays put.
    expect(body).toEqual({
      external_id: "HG-2050",
      // Shown in the Printify dashboard so a staff member can match it up.
      label: "HG-2050",
      line_items: [
        { product_id: "654321", variant_id: 5001, quantity: 1, external_id: "HG-2050:0" },
        { product_id: "654321", variant_id: 5002, quantity: 2, external_id: "HG-2050:1" },
      ],
      address_to: {
        first_name: "Huda", last_name: "Ali", address1: "12 High Street",
        // Sent explicitly rather than omitted: Printify documents address2 as a
        // string, and null is not accepted for it.
        address2: "",
        city: "London",
        zip: "E1 6AN", country: "GB",
        // UK addresses carry no state, so it is sent empty rather than absent.
        region: "",
        email: "huda@example.co.uk", phone: "+447700900123",
      },
      // The store's own shipping choice decides Printify's method.
      shipping_method: 1,
      // The storefront emails the customer; Printify must not double-email.
      send_shipping_notification: false,
    });
    // Retrying the same order builds a byte-identical request.
    expect(buildSubmitOrderPayload({ orderId: "HG-2050", email: "huda@example.co.uk", address: address(), lines: [payloadLine()] })).toEqual(
      buildSubmitOrderPayload({ orderId: "HG-2050", email: "huda@example.co.uk", address: address(), lines: [payloadLine()] }),
    );
  });

  it("maps the store's shipping method onto Printify's", () => {
    expect(printifyShippingMethod("UK Standard delivery")).toBe(1);
    expect(printifyShippingMethod("UK Express delivery")).toBe(3);
    expect(printifyShippingMethod("Express")).toBe(3);
    // Anything the store does not recognise falls back to standard: a parcel
    // that arrives later is recoverable, a rejected order is not.
    expect(printifyShippingMethod("something else")).toBe(1);
    expect(printifyShippingMethod("")).toBe(1);
  });

  it("throws instead of sending a partial or ambiguous order", () => {
    const base = { orderId: "HG-2050", email: "huda@example.co.uk", address: address() };
    expect(() => buildSubmitOrderPayload({ ...base, lines: [] })).toThrow(/no printify-managed lines/i);
    expect(() => buildSubmitOrderPayload({ ...base, lines: [payloadLine({ external_product_id: "" })] })).toThrow(/no imported printify product/i);
    expect(() => buildSubmitOrderPayload({ ...base, lines: [payloadLine({ printify_variant_id: undefined as unknown as number })] })).toThrow(/no mapped variant/i);
    expect(() => buildSubmitOrderPayload({ ...base, lines: [payloadLine({ quantity: 0 })] })).toThrow(/non-positive quantity/i);
    expect(() => buildSubmitOrderPayload({ ...base, address: address({ country: "Nowhere Land" }), lines: [payloadLine()] })).toThrow(/not a valid ISO/i);
  });

  it("converts the delivery country to the ISO code Printify requires", () => {
    expect(isoCountry("United Kingdom")).toBe("GB");
    expect(isoCountry("united kingdom")).toBe("GB");
    // 'UK' is two letters but is NOT an ISO alpha-2 value; sending it would fail
    // at submission, after the fulfilment claim is already taken out.
    expect(isoCountry("UK")).toBe("GB");
    expect(isoCountry("England")).toBe("GB");
    expect(isoCountry("gb")).toBe("GB");
    expect(isoCountry("Ireland")).toBe("IE");
    expect(isoCountry("Portugal")).toBe("");
    expect(isoCountry("")).toBe("");
    expect(() => buildSubmitOrderPayload({
      orderId: "HG-2050", email: "h@example.co.uk", address: address({ country: "Portugal" }), lines: [payloadLine()],
    })).toThrow(/ISO 3166-1/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Status + money display (provider cost is never a price)
// ---------------------------------------------------------------------------
describe("Printify status and cost helpers", () => {
  it("speaks Printify's lowercase statuses, not the retired integrator ones", () => {
    const list = PRINTIFY_STATUSES as readonly string[];
    expect(list).toContain("in-production");
    expect(list).toContain("payment-not-received");
    expect(list.every((s) => s === s.toLowerCase())).toBe(true);
    expect(list.some((s) => /^[A-Z]/.test(s))).toBe(false);
    expect(PRINTIFY_BLOCKED_STATUSES).toContain("has-issues");
    expect(printifyStatusMeaning("payment-not-received")).toMatch(/merchant/i);
    expect(printifyStatusMeaning("")).toBe("No status received.");
    expect(printifyStatusMeaning("something-new")).toBe("Status: something-new");
  });

  it("keeps minor-unit costs and retail pounds apart", () => {
    expect(costToPounds(9_950)).toBe(99.5);
    expect(costToPounds(-10)).toBe(0);
    expect(marginBetween(45, 9_900)).toBe(45 - 99);
    expect(marginBetween(140, 9_950)).toBe(40.5);
  });
});

// ---------------------------------------------------------------------------
// 7. The browser half: no token, no demo-mode fulfilment
// ---------------------------------------------------------------------------
describe("Printify browser client", () => {
  it("reads colours from either place a blueprint puts them", () => {
    expect(variantColours([
      { options: [{ name: "Colour", value: "Black" }] },
      { options: [{ name: "color", value: "Sand" }] },
      { colour: "Ivory" },
      { name: "Midnight" },
      { options: [{ name: "Size", value: "M" }] },
      {},
    ])).toEqual(["Black", "Sand", "Ivory", "Midnight"]);
    expect(variantColours(undefined)).toEqual([]);
  });

  it("is inert without a Supabase project, and says why", async () => {
    // Tests run with no VITE_SUPABASE_* configured: this is demo mode.
    expect(printifyReady()).toBe(false);
    for (const res of [await getStatus(), await getQueue(), await fulfil("HG-2050")]) {
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/server-side/i);
      expect(res.ok === false && res["unavailable"]).toBe(true);
    }
  });
});
