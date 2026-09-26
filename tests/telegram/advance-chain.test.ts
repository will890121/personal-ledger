import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { shortAdvanceRef } from "../../src/telegram/handlers/advances.js";
import {
  callbackUpdate,
  createHarness,
  firstDraftRef,
  getText,
  messageUpdate,
} from "../support/telegram-harness.js";
import type { FakeReferenceRepository } from "../support/fake-reference-repository.js";

const OWNER_ID = "123";

function seedReferences(referenceRepository: FakeReferenceRepository): void {
  referenceRepository.counterparties.push({
    counterpartyId: "friend",
    ownerId: OWNER_ID,
    name: "朋友",
    active: true,
  });
  referenceRepository.categories.push({
    categoryId: "category-lunch",
    ownerId: OWNER_ID,
    key: "expense_dining",
    name: "餐飲",
    kind: "expense",
    parentId: "category-expense",
    depth: 2,
    active: true,
  });
}

describe("advance lifecycle end to end", () => {
  it("keeps the allocation total equal to the transaction amount through recovery and abandonment", async () => {
    const { bot, calls, repository, referenceRepository } = createHarness();
    seedReferences(referenceRepository);

    // 1) 建立分帳：個人 630 + 代墊 630。
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1260，朋友欠一半" }));
    const advanceDraftId = [...repository.drafts.keys()][0] ?? "";
    expect(advanceDraftId).not.toBe("");

    // 2) 確認入帳。
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `confirm:${advanceDraftId}` }));
    const advanceTransaction = [...repository.transactions.values()][0];
    expect(advanceTransaction?.amount.amount).toBe("1260");
    const advanceAllocationId =
      advanceTransaction?.allocations.find((item) => item.purpose === "advance")?.allocationId ??
      "";
    expect(advanceAllocationId).not.toBe("");

    // 3) 部分回收 300（文字入口），確認後未回收餘額剩 330。
    await bot.handleUpdate(messageUpdate({ updateId: 3, text: "朋友還 300" }));
    const recoveryDraft = [...repository.drafts.values()].find((draft) =>
      draft.allocations.some((item) => item.purpose === "advance_recovery"),
    );
    expect(recoveryDraft?.amount.amount).toBe("300");
    expect(
      recoveryDraft?.allocations.find((item) => item.purpose === "advance_recovery")
        ?.recoversAllocationId,
    ).toBe(advanceAllocationId);
    await bot.handleUpdate(
      callbackUpdate({ updateId: 4, data: `confirm:${recoveryDraft?.draftId ?? ""}` }),
    );

    await bot.handleUpdate(messageUpdate({ updateId: 5, text: "/advances" }));
    expect(getText(calls.at(-1))).toContain("未回收 330");

    // 4) 放棄剩餘 330：原代墊縮成 300，放棄額另成一筆支出。
    const allocationRef = shortAdvanceRef(advanceAllocationId);
    await bot.handleUpdate(callbackUpdate({ updateId: 6, data: `aa:${allocationRef}` }));
    expect(getText(calls.at(-1))).toContain("放棄回收 330");
    await bot.handleUpdate(callbackUpdate({ updateId: 7, data: `aa-confirm:${allocationRef}` }));

    const updated = await repository.getTransaction(
      OWNER_ID,
      advanceTransaction?.transactionId ?? "",
    );
    expect(updated).not.toBeNull();
    // 本測試的重點：走完整條鏈之後，配置合計必須精確等於交易總額。
    const total = (updated?.allocations ?? []).reduce(
      (sum, item) => sum.plus(item.amount.amount),
      new Decimal(0),
    );
    expect(total.equals(new Decimal(updated?.amount.amount ?? "0"))).toBe(true);
    expect(total.equals(new Decimal("1260"))).toBe(true);
    // 金額必須為正，不得出現 0 元配置。
    expect(
      (updated?.allocations ?? []).every((item) => new Decimal(item.amount.amount).greaterThan(0)),
    ).toBe(true);
    expect(
      (updated?.allocations ?? [])
        .filter((item) => item.purpose === "advance")
        .map((item) => item.amount.amount),
    ).toEqual(["300"]);
    expect(
      (updated?.allocations ?? [])
        .filter((item) => item.purpose === "expense")
        .map((item) => item.amount.amount),
    ).toEqual(["630", "330"]);

    // 回收配置仍指向那筆縮小後的代墊，未回收餘額歸零。
    await bot.handleUpdate(messageUpdate({ updateId: 8, text: "/advances" }));
    expect(getText(calls.at(-1))).toContain("目前沒有未回收代墊");
  });

  it("completes an AC-11 split whose category is unknown instead of rejecting the input", async () => {
    const { bot, calls, repository, referenceRepository } = createHarness();
    seedReferences(referenceRepository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "聚餐 1260，我先付，朋友欠一半" }));

    // AC-11 的官方語句不得出現：「聚餐」只是分類未知，配置殼已經湊得出來。
    expect(getText(calls.at(-1))).not.toContain("無法解析");
    expect(getText(calls.at(-1))).toContain("待補分類");

    const draftRef = firstDraftRef(repository);
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

    const record = await repository.getDraftRecord({ ownerId: OWNER_ID, draftRef });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.amount.amount).toBe("1260");
    expect(record?.draft?.allocations.map((item) => item.amount.amount)).toEqual(["630", "630"]);
    expect(record?.draft?.allocations.map((item) => item.purpose)).toEqual(["expense", "advance"]);
    expect(record?.draft?.allocations[1]?.counterpartyId).toBe("friend");
    expect(record?.draft?.allocations.every((item) => item.categoryId === "category-lunch")).toBe(
      true,
    );
  });
});
