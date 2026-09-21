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

  it("lists drafts waiting for confirmation", async () => {
    const { bot, calls } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));

    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("待確認");
    expect(text).toContain("120");
  });

  it("reopens a pending draft when asked", async () => {
    const { bot, calls, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    const draftRef = firstDraftRef(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `o:${draftRef}` }));

    expect(getText(calls.at(-1))).toContain("待補金額");
  });

  it("says nothing is pending when the list is empty", async () => {
    const { bot, calls } = createHarness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/pending" }));

    expect(getText(calls.at(-1))).toContain("目前沒有待處理項目");
  });
});
