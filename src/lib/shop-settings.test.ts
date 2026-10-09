import { describe, expect, it, beforeEach } from "vitest";
import { updateSettings, whatsappLink } from "./shop-settings";

beforeEach(() => {
  localStorage.clear();
});

describe("checkout WhatsApp button logic", () => {
  it("returns null (button hidden, fallback shown) when no number is saved", () => {
    expect(whatsappLink("Hello")).toBeNull();
  });

  it("returns a wa.me link once the admin saves a number", () => {
    updateSettings({ whatsapp: "+44 7911 123456" });
    const link = whatsappLink("Hello HUDA GYMWEAR! Order of £80.00.");
    expect(link).toContain("https://wa.me/447911123456?text=");
    expect(link).toContain(encodeURIComponent("Hello HUDA GYMWEAR!"));
  });

  it("strips non-digits so formatted numbers still work", () => {
    updateSettings({ whatsapp: "  (020) 7946-0018 " });
    expect(whatsappLink("Hi")).toContain("https://wa.me/02079460018?text=");
  });
});
