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
});
