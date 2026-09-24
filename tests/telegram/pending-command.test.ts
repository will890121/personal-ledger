import { describe, expect, it } from "vitest";

import {
  callbackUpdate,
  createHarness,
  firstDraftRef,
  getText,
  messageUpdate,
} from "../support/telegram-harness.js";

describe("/pending", () => {
  it("lists drafts waiting for input", async () => {
    const { bot, calls } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));

    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("待補充");
    expect(text).toContain("午餐");
  });

  it("archives a draft on demand and drops it from the default list", async () => {
    const { bot, calls, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    const draftRef = firstDraftRef(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `z:${draftRef}` }));

    const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
    expect(record?.status).toBe("archived");

    await bot.handleUpdate(messageUpdate({ updateId: 3, text: "/pending" }));
    expect(getText(calls.at(-1))).toContain("目前沒有待處理項目");
  });

  it("refreshes the list in place after archiving instead of leaving it stale", async () => {
    const { bot, calls, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "午餐 120" }));
    const draftRef = firstDraftRef(repository);
    await bot.handleUpdate(messageUpdate({ updateId: 3, text: "/pending" }));

    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: `z:${draftRef}` }));

    const edit = calls.at(-1);
    expect(edit?.method).toBe("editMessageText");
    // 封存的是待補充那筆，就地更新後清單只應該剩下待確認組。
    expect(getText(edit)).not.toContain("待補充");
    expect(getText(edit)).toContain("待確認");
    expect(JSON.stringify(edit?.payload)).not.toContain(draftRef);
  });

  it("edits the same message when paging instead of sending a new list", async () => {
    const { bot, calls, repository } = createHarness();
    for (let index = 0; index < 12; index += 1) {
      await bot.handleUpdate(
        messageUpdate({ updateId: index + 1, text: `午餐 ${String(index + 1)}0` }),
      );
    }
    await bot.handleUpdate(messageUpdate({ updateId: 20, text: "/pending" }));
    expect(repository.drafts.size).toBe(12);

    await bot.handleUpdate(callbackUpdate({ updateId: 21, data: "p:confirm:1" }));

    const edit = calls.at(-1);
    expect(edit?.method).toBe("editMessageText");
    expect(getText(edit)).toContain("待確認（2 / 2）");
  });

  it("tells the caller when the archived draft is already gone", async () => {
    const { bot, calls } = createHarness();

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: "z:aabbccdd" }));

    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("草稿不存在");
  });

  it("lists drafts waiting for confirmation", async () => {
    const { bot, calls } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));

    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("待確認");
    expect(text).toContain("120");
    expect(text).toContain("午餐 120");
  });

  it("reopens a pending draft when asked", async () => {
    const { bot, calls, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    const draftRef = firstDraftRef(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `o:${draftRef}` }));

    expect(getText(calls.at(-1))).toContain("待補金額");
  });

  it("offers a close button that removes the list", async () => {
    const { bot, calls } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("dismiss-pending");

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: "dismiss-pending" }));

    expect(calls.at(-1)?.method).toBe("deleteMessage");
  });

  it("closes the previous list when a new one is requested", async () => {
    const { bot, calls } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));

    await bot.handleUpdate(messageUpdate({ updateId: 3, text: "/pending" }));

    const deletions = calls.filter((call) => call.method === "deleteMessage");
    expect(deletions).toHaveLength(1);
    // 第一份清單是第二則送出的訊息，因此 message_id 為 2。
    expect(JSON.stringify(deletions[0]?.payload)).toContain('"message_id":2');
  });

  it("keeps working when the previous list can no longer be deleted", async () => {
    const { bot, calls, repository } = createHarness({ failDeleteMessage: true });
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));

    await bot.handleUpdate(messageUpdate({ updateId: 3, text: "/pending" }));

    expect(getText(calls.at(-1))).toContain("待補充");
    expect(await repository.getSetting("123", "pending_list_message")).not.toBeNull();
  });

  it("says nothing is pending when the list is empty", async () => {
    const { bot, calls } = createHarness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/pending" }));

    expect(getText(calls.at(-1))).toContain("目前沒有待處理項目");
  });
});
