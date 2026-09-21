import { Bot } from "grammy";

import type { LedgerBotDependencies } from "./dependencies.js";
import { registerDraftHandlers } from "./handlers/drafts.js";
import { registerSummaryHandlers } from "./handlers/summaries.js";
import { registerTransactionHandlers } from "./handlers/transactions.js";

export type { LedgerBotDependencies };
export { formatRecentPage } from "./handlers/transactions.js";

export function createLedgerBot(dependencies: LedgerBotDependencies): Bot {
  const bot = dependencies.botInfo
    ? new Bot(dependencies.token, { botInfo: dependencies.botInfo })
    : new Bot(dependencies.token);

  bot.use(async (context, next) => {
    const isOwner = context.from && String(context.from.id) === dependencies.ownerId;
    const isPrivate = context.chat?.type === "private";
    if (!isOwner || !isPrivate) {
      return;
    }
    await next();
  });

  registerTransactionHandlers(bot, dependencies);
  registerSummaryHandlers(bot, dependencies);
  registerDraftHandlers(bot, dependencies);

  return bot;
}
