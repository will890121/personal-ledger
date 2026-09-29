import { describe, expect, it } from "vitest";

import {
  callbackUpdate,
  createHarness,
  firstDraftRef,
  getText,
  messageUpdate,
} from "../support/telegram-harness.js";
import type { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function seedCategories(referenceRepository: FakeReferenceRepository): void {
  for (const [categoryId, key, name] of [
    ["category-dining", "expense_dining", "餐飲"],
    ["category-transport", "expense_transport", "交通"],
  ] as const) {
    referenceRepository.categories.push({
      categoryId,
      ownerId: "123",
      key,
      name,
      kind: "expense",
      parentId: "category-expense",
      depth: 2,
      active: true,
    });
  }
}

function harness() {
  const created = createHarness();
  seedCategories(created.referenceRepository);
  return created;
}

/** 走完「解不出分類 → 按下分類按鈕」，回傳該草稿的 ref 與這一輪的所有 API 呼叫。 */
async function answerCategory(text: string, categoryIndex = 0) {
  const created = harness();
  await created.bot.handleUpdate(messageUpdate({ updateId: 1, text }));
  const draftRef = firstDraftRef(created.repository);
  await created.bot.handleUpdate(
    callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:${String(categoryIndex)}` }),
  );
  return { ...created, draftRef };
}

describe("teaching a category keyword", () => {
  it("offers to remember the word after the category is answered", async () => {
    const { calls, draftRef } = await answerCategory("牛排 300");

    const offer = getText(calls.at(-1));
    expect(offer).toContain("還不認識「牛排」");
    expect(offer).toContain("餐飲");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(`"k:${draftRef}:1"`);
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(`"k:${draftRef}:0"`);
  });

  it("remembers the word so the next message needs no follow-up", async () => {
    const { bot, calls, repository, referenceRepository, draftRef } =
      await answerCategory("牛排 300");

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `k:${draftRef}:1` }));

    expect(referenceRepository.userCategoryKeywords).toEqual([
      { ownerId: "123", keyword: "牛排", categoryId: "category-dining" },
    ]);

    await bot.handleUpdate(messageUpdate({ updateId: 4, text: "牛排 500" }));
    const preview = getText(calls.at(-1));
    expect(preview).toContain("總金額：TWD 500");
    expect(preview).toContain("餐飲／牛排");
    expect(preview).not.toContain("待補分類");
    const second = [...repository.records.values()].at(-1);
    expect(second?.status).toBe("awaiting_confirmation");
  });

  it("stores nothing when the offer is declined", async () => {
    const { bot, calls, referenceRepository, draftRef } = await answerCategory("牛排 300");

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `k:${draftRef}:0` }));

    expect(referenceRepository.userCategoryKeywords).toEqual([]);
    expect(getText(calls.at(-1))).toContain("這次不記");
  });

  it("does not offer when the sentence leaves no clean candidate", async () => {
    // 「國泰卡刷 1200」剝掉帳戶與金額只剩一個「刷」字，不該提議。
    const created = harness();
    created.referenceRepository.accounts.push({
      accountId: "account-card",
      ownerId: "123",
      name: "國泰卡",
      type: "credit_card",
      currency: "TWD",
      active: true,
    });
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "國泰卡刷 1200" }));
    const draftRef = firstDraftRef(created.repository);

    await created.bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

    expect(getText(created.calls.at(-1))).not.toContain("還不認識");
  });
  it("does not offer after answering a field other than the category", async () => {
    // 觸發條件是「剛補完的欄位是分類」。這句話的分類靠內建關鍵字「晚餐」就解得出來，
    // 缺的是金額；補完金額之後草稿也完整了，但使用者並沒有在選分類，不該跳出提議。
    const created = harness();
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "晚餐 一蘭拉麵" }));
    const draftRef = firstDraftRef(created.repository);
    await created.bot.handleUpdate(messageUpdate({ updateId: 2, text: "300" }));

    await created.bot.handleUpdate(callbackUpdate({ updateId: 3, data: `v:${draftRef}:300` }));

    const record = await created.repository.getDraftRecord({ ownerId: "123", draftRef });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(getText(created.calls.at(-1))).not.toContain("還不認識");
  });

  it("prefers the longest taught keyword when two of them match", async () => {
    const created = harness();
    created.referenceRepository.userCategoryKeywords.push(
      { ownerId: "123", keyword: "拉麵", categoryId: "category-transport" },
      { ownerId: "123", keyword: "一蘭拉麵", categoryId: "category-dining" },
    );

    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "一蘭拉麵 200" }));

    const preview = getText(created.calls.at(-1));
    expect(preview).toContain("餐飲／一蘭拉麵");
    expect(preview).not.toContain("交通");
  });

  it("does not offer when the sentence leaves two unknown fragments", async () => {
    // 剩兩段代表這句話還有別的沒被解析，挑其中一段當關鍵字只是在猜。
    const created = harness();
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "一蘭拉麵 牛排 300" }));
    const draftRef = firstDraftRef(created.repository);

    await created.bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

    expect(getText(created.calls.at(-1))).not.toContain("還不認識");
  });
  it("treats a second tap on 記住 as success, not failure", async () => {
    // 記住之後那個詞就成了「已知詞」，重新推導會得到 undefined。若照著回「無法記住」，
    // 使用者看到的是一則失敗訊息，而事情其實已經做好了。
    const { bot, calls, referenceRepository, draftRef } = await answerCategory("牛排 300");
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `k:${draftRef}:1` }));

    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: `k:${draftRef}:1` }));

    expect(referenceRepository.userCategoryKeywords).toHaveLength(1);
    expect(getText(calls.at(-1))).toContain("記成餐飲");
    expect(getText(calls.at(-1))).not.toContain("無法記住");
  });
});

describe("/keywords", () => {
  it("lists what has been taught, with a delete button for each", async () => {
    const created = harness();
    created.referenceRepository.userCategoryKeywords.push(
      { ownerId: "123", keyword: "牛排", categoryId: "category-dining" },
      { ownerId: "123", keyword: "加油站", categoryId: "category-transport" },
    );

    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "/keywords" }));

    const text = getText(created.calls.at(-1)) ?? "";
    expect(text).toContain("牛排 · 餐飲");
    expect(text).toContain("加油站 · 交通");
    const payload = JSON.stringify(created.calls.at(-1)?.payload);
    expect(payload).toContain('"text":"刪除 牛排"');
    expect(payload).toContain('"text":"刪除 加油站"');
    // 與 /pending、/advances、/recent 一致：清單訊息最後一列是關閉鍵，否則它會一直
    // 留在對話裡佔位置。
    const rows = (
      created.calls.at(-1)?.payload as { reply_markup: { inline_keyboard: { text: string }[][] } }
    ).reply_markup.inline_keyboard;
    expect(rows.at(-1)).toEqual([{ text: "關閉清單", callback_data: "dismiss-keywords" }]);
  });

  it("closes the list when the close button is pressed", async () => {
    const created = harness();
    created.referenceRepository.userCategoryKeywords.push({
      ownerId: "123",
      keyword: "牛排",
      categoryId: "category-dining",
    });
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "/keywords" }));

    await created.bot.handleUpdate(callbackUpdate({ updateId: 2, data: "dismiss-keywords" }));

    expect(created.calls.at(-1)?.method).toBe("deleteMessage");
    // 關閉只是收起訊息，不該動到教過的詞。
    expect(created.referenceRepository.userCategoryKeywords).toHaveLength(1);
  });

  it("says so when nothing has been taught yet", async () => {
    const created = harness();

    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "/keywords" }));

    expect(getText(created.calls.at(-1))).toContain("還沒有教過任何詞");
  });

  it("deleting a keyword makes the word ask for a category again", async () => {
    // 教錯之後那個詞永遠不再追問，也就永遠不會再跳出「要記住嗎」。沒有這條路，
    // 一次誤觸就會讓之後每一筆含這個詞的交易都被歸錯分類。
    const created = harness();
    created.referenceRepository.userCategoryKeywords.push({
      ownerId: "123",
      keyword: "牛排",
      categoryId: "category-transport",
    });
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "/keywords" }));
    const payload = JSON.stringify(created.calls.at(-1)?.payload);
    const data = /"callback_data":"(kd:[^"]+)"/.exec(payload)?.[1] ?? "";
    expect(data).not.toBe("");

    await created.bot.handleUpdate(callbackUpdate({ updateId: 2, data }));

    expect(created.referenceRepository.userCategoryKeywords).toEqual([]);
    await created.bot.handleUpdate(messageUpdate({ updateId: 3, text: "牛排 300" }));
    expect(getText(created.calls.at(-1))).toContain("待補分類");
  });
  it("keeps only the most recent list", async () => {
    // 與 /pending、/advances 一致。留著舊清單不只是佔位置：刪除鍵綁著清單內容，
    // 過期的那份仍然可以按下去。
    const created = harness();
    created.referenceRepository.userCategoryKeywords.push({
      ownerId: "123",
      keyword: "牛排",
      categoryId: "category-dining",
    });
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "/keywords" }));
    const firstId = created.calls.filter((call) => call.method === "sendMessage").length;

    await created.bot.handleUpdate(messageUpdate({ updateId: 2, text: "/keywords" }));

    const deletions = created.calls.filter((call) => call.method === "deleteMessage");
    expect(deletions).toHaveLength(1);
    expect(JSON.stringify(deletions[0]?.payload)).toContain(`"message_id":${String(firstId)}`);
  });

  it("deletes the word the button named, even if the list has changed since", async () => {
    // 刪除鍵若帶的是清單索引，前面的詞一被移除，同一個索引就指向別的詞——按下「刪除 丙」
    // 會靜靜刪掉「丁」。短碼由關鍵字本身導出，永遠指向同一個詞。
    const created = harness();
    for (const keyword of ["甲", "乙", "丙", "丁"]) {
      created.referenceRepository.userCategoryKeywords.push({
        ownerId: "123",
        keyword,
        categoryId: "category-dining",
      });
    }
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "/keywords" }));
    const payload = JSON.stringify(created.calls.at(-1)?.payload);
    const third = /"text":"刪除 丙","callback_data":"(kd:[^"]+)"/.exec(payload)?.[1] ?? "";
    expect(third).not.toBe("");

    // 清單送出之後第一個詞先被移除，索引整個往前挪。
    created.referenceRepository.userCategoryKeywords.splice(0, 1);
    await created.bot.handleUpdate(callbackUpdate({ updateId: 2, data: third }));

    expect(created.referenceRepository.userCategoryKeywords.map((item) => item.keyword)).toEqual([
      "乙",
      "丁",
    ]);
    expect(getText(created.calls.at(-1))).toContain("丙");
  });
});
