import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";

import type { IncompleteDraft } from "../domain/draft.js";
import type { BatchItem } from "../application/create-batch.js";
import type { ReferenceSnapshot } from "../application/reference-data.js";
import { encodeCallback } from "./callback-data.js";

const MAX_CANDIDATES = 10;
const BUTTONS_PER_ROW = 2;

const fieldLabels = {
  amount: "金額",
  category: "分類",
  account: "帳戶",
  refundTarget: "退款原交易",
  purpose: "用途",
  counterparty: "交易對象",
  advanceShare: "代墊金額",
} as const;

export interface DraftPrompt {
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export function formatPrompt(
  draft: IncompleteDraft,
  draftRef: string,
  references: Partial<ReferenceSnapshot>,
): DraftPrompt {
  const pending = draft.pendingFields[0];
  if (!pending) throw new Error("incomplete draft must have a pending field");
  const segment = draft.partial.rawSegment;

  if (pending.field === "amount") {
    return { text: [`待補金額：${segment}`, "請回覆這則訊息並輸入金額。"].join("\n") };
  }

  const labels = new Map<string, string>([
    ...(references.categories ?? []).map((item) => [item.categoryId, item.name] as const),
    ...(references.accounts ?? []).map((item) => [item.accountId, item.name] as const),
  ]);
  const buttons: InlineKeyboardButton[] = pending.candidateIds
    .slice(0, MAX_CANDIDATES)
    .map((id, index) => ({
      text: labels.get(id) ?? id,
      callback_data: encodeCallback({ kind: "answer", draftRef, field: pending.field, index }),
    }));
  const rows = buttons.reduce<InlineKeyboardButton[][]>((acc, button, index) => {
    if (index % BUTTONS_PER_ROW === 0) acc.push([]);
    acc.at(-1)?.push(button);
    return acc;
  }, []);

  return {
    text: [`待補${fieldLabels[pending.field]}：${segment}`, "請選擇："].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

export function formatBatchSummary(items: readonly BatchItem[]): string {
  const counts = { draft: 0, incomplete: 0, unparsed: 0 };
  for (const item of items) counts[item.outcome.kind] += 1;
  const parts = [
    ...(counts.draft > 0 ? [`${String(counts.draft)} 筆待確認`] : []),
    ...(counts.incomplete > 0 ? [`${String(counts.incomplete)} 筆待補欄位`] : []),
    ...(counts.unparsed > 0 ? [`${String(counts.unparsed)} 筆無法解析`] : []),
  ];
  return `${String(items.length)} 筆：${parts.join("、")}`;
}
