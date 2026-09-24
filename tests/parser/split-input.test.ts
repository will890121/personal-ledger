import { describe, expect, it } from "vitest";

import { splitInput } from "../../src/parser/split-input.js";

describe("splitInput", () => {
  it("splits on separators when each segment carries an amount", () => {
    expect(splitInput("午餐 120，咖啡 60")).toEqual(["午餐 120", "咖啡 60"]);
  });

  it("merges segments without an amount into the previous segment", () => {
    expect(splitInput("聚餐 1260，我先付，朋友欠一半")).toEqual(["聚餐 1260，我先付，朋友欠一半"]);
  });

  it("merges a leading segment without an amount into the next segment", () => {
    expect(splitInput("我先付，聚餐 1260")).toEqual(["我先付，聚餐 1260"]);
  });

  it("keeps existing transfer syntax as a single segment", () => {
    expect(splitInput("台新轉國泰 1000 手續費 15")).toEqual(["台新轉國泰 1000 手續費 15"]);
  });

  it("splits on newlines and ideographic commas", () => {
    expect(splitInput("午餐 120\n咖啡 60、晚餐 300")).toEqual(["午餐 120", "咖啡 60", "晚餐 300"]);
  });

  it("ignores empty segments and whitespace", () => {
    expect(splitInput("  午餐 120，，  ")).toEqual(["午餐 120"]);
    expect(splitInput("   ")).toEqual([]);
  });

  it("merges a pure owed-amount clause into the previous segment despite carrying a number", () => {
    expect(splitInput("午餐 1260，小明欠 630")).toEqual(["午餐 1260，小明欠 630"]);
  });

  it("merges a pure pays-for-someone clause into the previous segment despite carrying a number", () => {
    expect(splitInput("午餐 1260，幫小華付 500")).toEqual(["午餐 1260，幫小華付 500"]);
  });

  it("still splits two ordinary amount-bearing transactions", () => {
    expect(splitInput("午餐 120，咖啡 60")).toEqual(["午餐 120", "咖啡 60"]);
  });

  it("still merges a name-only sharing clause without an amount", () => {
    expect(splitInput("聚餐 1260，我先付，朋友欠一半")).toEqual(["聚餐 1260，我先付，朋友欠一半"]);
  });

  it("does not merge a segment that owes an amount but also carries other content", () => {
    expect(splitInput("午餐 120，小明欠 630 加小費 50")).toEqual([
      "午餐 120",
      "小明欠 630 加小費 50",
    ]);
  });
});
