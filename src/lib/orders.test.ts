import { describe, expect, it } from "vitest";
import { nextStatuses, type Order, type OrderStatus } from "./orders";

function makeOrder(over: Partial<Order> & { status: OrderStatus; timeline: Order['timeline'] }): Order {
  return {
    id: 'HG-TEST',
    email: 'test@example.co.uk',
    customer: 'Test User',
    address: { firstName: 'Test', lastName: 'User', street: '1 Test St', city: 'London', postcode: 'E2 8DP', country: 'United Kingdom', phone: '' },
    items: [],
    subtotal: 0,
    discount: 0,
    shipping: { method: 'UK standard delivery', price: 0 },
    total: 0,
    payment: 'cod',
    paymentStatus: 'Cash on delivery',
    createdAt: new Date().toISOString(),
    ...over,
  };
}
const at = (s: OrderStatus) => ({ status: s, at: new Date().toISOString() });

describe("nextStatuses", () => {
  it("offers Received + Cancelled for a fresh COD order", () => {
    const o = makeOrder({ status: 'Order received', timeline: [at('Order received')] });
    expect(nextStatuses(o)).toEqual(['Received', 'Cancelled']);
  });
  it("offers Packed for a non-linear history that already passed Received (HG-1036 case)", () => {
    const o = makeOrder({
      status: 'Order received',
      payment: 'bank',
      paymentStatus: 'Paid',
      timeline: [at('Awaiting payment proof'), at('Received'), at('Order received')],
    });
    expect(nextStatuses(o)).toEqual(['Packed', 'Cancelled']);
  });
  it("locks unpaid bank orders to Cancelled only", () => {
    const o = makeOrder({ status: 'Awaiting payment proof', payment: 'bank', paymentStatus: 'Pending proof', timeline: [at('Awaiting payment proof')] });
    expect(nextStatuses(o)).toEqual(['Cancelled']);
  });
  it("restarts unknown statuses safely at Received", () => {
    const o = makeOrder({ status: 'Order received', timeline: [] });
    expect(nextStatuses(o)).toEqual(['Received', 'Cancelled']);
  });
  it("offers nothing for Delivered or Cancelled orders", () => {
    expect(nextStatuses(makeOrder({ status: 'Delivered', timeline: [at('Delivered')] }))).toEqual([]);
    expect(nextStatuses(makeOrder({ status: 'Cancelled', timeline: [at('Cancelled')] }))).toEqual([]);
  });
});
