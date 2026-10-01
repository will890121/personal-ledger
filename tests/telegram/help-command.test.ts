import { describe, expect, it } from "vitest";

import { LEDGER_COMMANDS } from "../../src/telegram/commands.js";
import { registerCommandMenu } from "../../src/telegram/create-bot.js";
import { formatHelp } from "../../src/telegram/format-help.js";
import { createHarness as harness, getText, messageUpdate } from "../support/telegram-harness.js";

// drafts.ts 的 catch-all 也會回一則訊息（「無法解析這筆輸入」），所以光看
// 「有沒有回覆」不夠——一個指令被吞掉、落到 catch-all 時一樣會有 calls.length > 0，
// 測試卻誤判成通過。用這個字串排除掉那個假陽性，才是真的在驗證指令有被自己的
// handler 接住，而不是被 drafts.ts 攔截。
const DRAFT_FALLBACK_TEXT = "無法解析這筆輸入";

describe("/help", () => {
  it("leads with what you can type, not with the command list", () => {
    // 這個 bot 的主要介面是自由文字；三個月後會忘記的是句子怎麼寫。
    const text = formatHelp();

    expect(text.indexOf("午餐 120")).toBeLessThan(text.indexOf("/pending"));
    expect(text).toContain("薪水 +85000");
    expect(text).toContain("午餐 1260，小明欠 630");
  });

  // spec §6b 明確要求這四種語法各自至少出現一次；本專案確實支援它們
  // （src/parser/rule-parser.ts 的日期前綴、src/parser/split-share.ts 的
  // COUNT_PATTERN 與回收句錨定、src/application/create-batch.ts 的 splitInput），
  // 但前一輪的 /help 全部漏掉。逐一釘住每一句範例文字，而不是只斷言三個段落
  // 標題存在：只斷言標題的話，拿掉「小明還 300」這一行、測試仍然是綠的。
  it.each([
    ["date prefix", "昨天 Uber 245 國泰卡"],
    ["equal split", "午餐 1000，三個人平分"],
    ["repayment", "小明還 300"],
    // 2026-10-02：分隔符改成只有換行。/help 必須教換行，否則它會教一個已經不成立的
    // 寫法——使用者照著打「午餐 120，Uber 245」只會得到一張缺金額的草稿。
    ["multiple entries in one message", "一次多筆（換行分隔，一行一筆）"],
  ])("mentions the %s syntax via `%s`", (_label, example) => {
    expect(formatHelp()).toContain(example);
  });

  it("lists every registered command", () => {
    const text = formatHelp();

    for (const { command } of LEDGER_COMMANDS) {
      expect(text).toContain(`/${command}`);
    }
  });

  it("registers the same list with Telegram so the / menu shows it", async () => {
    const { bot, calls } = harness();

    await registerCommandMenu(bot);

    const call = calls.find((item) => item.method === "setMyCommands");
    expect(call).toBeDefined();
    expect(
      (call?.payload as { commands: { command: string }[] }).commands.map((c) => c.command),
    ).toEqual(LEDGER_COMMANDS.map((c) => c.command));
  });

  it("keeps the command list and the handlers in step", () => {
    // 手寫的清單一定會漂移。本專案已經因為「同一件事兩份定義」出過三次問題。
    expect(LEDGER_COMMANDS.map((item) => item.command).sort()).toEqual([
      "advances",
      "help",
      "keywords",
      "month",
      "pending",
      "recent",
      "status",
      "today",
    ]);
  });

  it("actually replies when invoked, without hitting the drafts.ts catch-all", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/help" }));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)?.method).toBe("sendMessage");
    expect(getText(calls.at(-1))).not.toContain(DRAFT_FALLBACK_TEXT);
  });
});

describe("LEDGER_COMMANDS registration order", () => {
  // drafts.ts 掛了一支 bot.on("message:text") 的 catch-all，不呼叫 next()，會吞掉任何
  // 排在它後面註冊的指令——/status 能動只是因為它剛好排在 drafts.ts 之前。這條測試把
  // 「新指令要記得排在 catch-all 之前」從一句只存在於註解裡的提醒，變成一個真的會紅的
  // 測試：往後任何人加了第九個指令，只要忘記排在正確位置，這裡就會失敗，而不必等到
  // 那個指令自己的測試被寫出來才發現。
  it.each(LEDGER_COMMANDS.map((item) => item.command))(
    "/%s is handled by its own registered command, not by the catch-all",
    async (command) => {
      const { bot, calls } = harness();

      await bot.handleUpdate(messageUpdate({ updateId: 1, text: `/${command}` }));

      expect(calls.length, `/${command} produced no reply at all`).toBeGreaterThan(0);
      // 只看「有沒有回覆」不夠：drafts.ts 的 catch-all 也會回一則「無法解析這筆輸入」，
      // 被吞掉的指令一樣會通過 calls.length > 0 這關。必須排除掉那句話，才真的驗證到
      // 「這個指令有自己的 handler 接住，而不是掉進 catch-all」。
      expect(getText(calls.at(-1))).not.toContain(DRAFT_FALLBACK_TEXT);
    },
  );
});
