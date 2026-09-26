import { describe, expect, it } from "vitest";

import { parseShare } from "../../src/parser/split-share.js";

describe("parseShare", () => {
  it("returns none when the text has no sharing phrase", () => {
    expect(parseShare("午餐 120", "120")).toEqual({ kind: "none" });
  });

  it("reads a half split with one named counterparty", () => {
    expect(parseShare("聚餐 1260，我先付，朋友欠一半", "1260")).toEqual({
      kind: "split",
      participants: 2,
      names: ["朋友"],
      share: "630",
    });
  });

  it("reads an explicit amount", () => {
    expect(parseShare("聚餐 1260，小明欠 630", "1260")).toEqual({
      kind: "explicit",
      shares: [{ name: "小明", amount: "630" }],
    });
  });

  it("reads a three way split and leaves unparseable names to the follow-up", () => {
    // 逗號列舉的名字不在四種明確寫法內（X欠、X要還、X該給、幫X付）
    // 應由應用層追問
    expect(parseShare("聚餐 1260，小明，小華，三個人平分", "1260")).toEqual({
      kind: "split",
      participants: 3,
      names: [],
      share: "420",
    });
  });

  it("reports a split that does not divide exactly", () => {
    expect(parseShare("聚餐 1000，三個人平分", "1000")).toEqual({
      kind: "not_divisible",
      participants: 3,
      names: [],
    });
  });

  it("accepts arabic and chinese participant counts", () => {
    const arabic = parseShare("聚餐 900，3 個人平分", "900");
    const chinese = parseShare("聚餐 900，三個人平分", "900");

    expect(arabic).toEqual(chinese);
  });

  it("treats 平分 without a count as two people", () => {
    expect(parseShare("聚餐 500，跟小明平分", "500")).toMatchObject({
      kind: "split",
      participants: 2,
      share: "250",
    });
  });

  it("ignores the amount token when extracting names", () => {
    const result = parseShare("聚餐 1260，朋友欠一半", "1260");

    expect(result.kind).toBe("split");
    if (result.kind !== "split") return;
    expect(result.names).not.toContain("1260");
  });

  it("only takes names from the four explicit forms", () => {
    expect(parseShare("聚餐 1260，現金支付，三個人平分", "1260")).toMatchObject({ names: [] });
    expect(parseShare("聚餐 1260，幫小明付，三個人平分", "1260")).toMatchObject({
      names: ["小明"],
    });
  });
});
