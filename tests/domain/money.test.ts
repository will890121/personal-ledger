import { describe, expect, it } from "vitest";

import { addMoney, money } from "../../src/domain/money.js";

describe("money", () => {
  it("normalizes decimal amounts without losing precision", () => {
    expect(money("00120.00", "TWD")).toEqual({
      amount: "120",
      currency: "TWD",
    });
  });

  it.each(["0", "-1", "NaN", "Infinity"])("rejects non-positive amount %s", (amount) => {
    expect(() => money(amount, "TWD")).toThrow("money amount must be positive");
  });
});

describe("addMoney", () => {
  it("adds decimal amounts exactly", () => {
    expect(addMoney(money("0.1", "TWD"), money("0.2", "TWD"))).toEqual({
      amount: "0.3",
      currency: "TWD",
    });
  });
});
