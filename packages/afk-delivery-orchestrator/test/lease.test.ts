import { describe, expect, it } from "vitest";
import { deliveryLeaseGroup } from "../src/index.js";

describe("deliveryLeaseGroup", () => {
  it("assigns competing workers for the same ticket to the same Delivery Lease", () => {
    expect(deliveryLeaseGroup("acme/wiki", { ticketNumber: 64 }))
      .toBe(deliveryLeaseGroup("acme/wiki", { ticketNumber: 64 }));
  });

  it("allows unrelated Delivery Tickets to progress concurrently", () => {
    expect(deliveryLeaseGroup("acme/wiki", { ticketNumber: 64 }))
      .not.toBe(deliveryLeaseGroup("acme/wiki", { ticketNumber: 65 }));
  });

  it("keeps a Managed PR and its Delivery Ticket under one lease identity", () => {
    expect(deliveryLeaseGroup("acme/wiki", { ticketNumber: 64, prNumber: 70 }))
      .toBe(deliveryLeaseGroup("acme/wiki", { ticketNumber: 64 }));
  });
});
