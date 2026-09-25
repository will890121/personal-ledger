import { Decimal } from "decimal.js";

import type { RecordRecoveryResult } from "../application/record-recovery.js";
import type { ReferenceSnapshot } from "../application/reference-data.js";
import type { IncompleteDraft } from "../domain/draft.js";
import { formatPrompt, type DraftPrompt } from "./format-prompt.js";

type SurplusRecoveryResult = Extract<RecordRecoveryResult, { kind: "incomplete" }>;

// 待補分類的配置一定是 purpose=advance_recovery（沖抵代墊的那幾筆都沿用同一個
// counterpartyId），從草稿本身就能取回是誰還的錢，不必請呼叫端另外傳一次。
function findCounterpartyName(
  draft: IncompleteDraft,
  references: Partial<ReferenceSnapshot>,
): string {
  const counterpartyId = draft.partial.allocations.find(
    (item) => item.purpose === "advance_recovery",
  )?.counterpartyId;
  const name = references.counterparties?.find(
    (item) => item.counterpartyId === counterpartyId,
  )?.name;
  return name ?? "對方";
}

/**
 * 超額回收沖抵了哪幾筆代墊，答案就在 `RecordRecoveryResult`（回收流程手上的
 * `plan.items`），而不在通用的 `IncompleteDraft` 裡——`formatPrompt` 看不到
 * 這份脈絡，只會產生「待補分類：小明還 700」這種讓人摸不著頭緒的提問。
 * 這裡由回收流程自己組訊息，把沖抵金額、被沖抵代墊的日期、剩餘待分類金額都
 * 寫清楚；分類候選按鈕仍是通用邏輯，直接借用 `formatPrompt` 算好的鍵盤即可，
 * 不必重新刻一份選單組裝規則。
 */
export function formatRecoverySurplusPrompt(
  result: SurplusRecoveryResult,
  references: Partial<ReferenceSnapshot>,
): DraftPrompt {
  const replyMarkup = formatPrompt(result.draft, result.draftRef, references).replyMarkup;
  const counterpartyName = findCounterpartyName(result.draft, references);

  const appliedTotal = result.recovered
    .reduce((sum, item) => sum.plus(item.amount), new Decimal(0))
    .toString();
  const received = new Decimal(appliedTotal).plus(result.surplus).toString();

  const dateText =
    result.recovered.length > 1
      ? `共沖抵 ${String(result.recovered.length)} 筆代墊（${result.recovered
          .map((item) => item.occurredDate)
          .join("、")}）`
      : `${result.recovered[0]?.occurredDate ?? ""} 的代墊`;

  const text = [
    `${counterpartyName}還 ${received}：其中 ${appliedTotal} 沖抵 ${dateText}，剩餘 ${result.surplus} 需要分類。`,
    `請選擇 ${result.surplus} 的收入分類：`,
  ].join("\n");

  return { text, ...(replyMarkup ? { replyMarkup } : {}) };
}
