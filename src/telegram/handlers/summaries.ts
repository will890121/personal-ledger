import type { Bot } from "grammy";

import { getMonthSummary, getTodaySummary } from "../../application/ledger-summary.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { formatSummary } from "../format-summary.js";

export function registerSummaryHandlers(bot: Bot, dependencies: LedgerBotDependencies): void {
  bot.command("today", async (context) => {
    const summary = await getTodaySummary(dependencies.ownerId, {
      repository: dependencies.summaryRepository,
      today: dependencies.today,
    });
    await context.reply(formatSummary("今日摘要", summary));
  });

  bot.command("month", async (context) => {
    const summary = await getMonthSummary(dependencies.ownerId, {
      repository: dependencies.summaryRepository,
      today: dependencies.today,
    });
    await context.reply(formatSummary("本月摘要", summary));
  });
}
