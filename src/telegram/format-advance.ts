import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";

import type { CounterpartyAdvances } from "../application/list-advances.js";
import { encodeCallback } from "./callback-data.js";

const ADVANCES_PAGE_SIZE = 10;

export interface AdvanceRefs {
  readonly counterparty: ReadonlyMap<string, string>;
  readonly allocation: ReadonlyMap<string, string>;
}

export interface AdvanceView {
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export function formatAdvances(
  groups: readonly CounterpartyAdvances[],
  refs: AdvanceRefs,
  page: number,
): AdvanceView {
  const totalPages = Math.ceil(groups.length / ADVANCES_PAGE_SIZE);
  const slice = groups.slice(page * ADVANCES_PAGE_SIZE, (page + 1) * ADVANCES_PAGE_SIZE);
  if (slice.length === 0) return { text: "目前沒有未回收代墊。" };

  const lines: string[] = [];
  const rows: InlineKeyboardButton[][] = [];
  for (const group of slice) {
    lines.push(`${group.name} · 未回收 ${group.total}（${String(group.items.length)} 筆）`);
    const counterpartyRef = refs.counterparty.get(group.counterpartyId) ?? "";
    rows.push([
      {
        text: `記錄收款 ${group.name}`,
        callback_data: encodeCallback({ kind: "advance-recover", ref: counterpartyRef }),
      },
    ]);
    for (const item of group.items) {
      lines.push(
        `· ${item.occurredDate} 原 ${item.amount} 已回收 ${item.recovered} 餘 ${item.outstanding}`,
      );
      const allocationRef = refs.allocation.get(item.allocationId) ?? "";
      rows.push([
        {
          text: `放棄回收 ${item.outstanding}`,
          callback_data: encodeCallback({ kind: "advance-abandon", ref: allocationRef }),
        },
      ]);
    }
  }
  if (totalPages > 1) {
    rows.push([
      ...(page > 0 ? [{ text: "上一頁", callback_data: `advances-page:${String(page - 1)}` }] : []),
      ...(page < totalPages - 1
        ? [{ text: "下一頁", callback_data: `advances-page:${String(page + 1)}` }]
        : []),
    ]);
  }
  rows.push([{ text: "關閉清單", callback_data: "dismiss-advances" }]);
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: rows } };
}
