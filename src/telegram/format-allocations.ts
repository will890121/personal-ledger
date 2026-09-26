import type { Allocation } from "../domain/ledger.js";
import type { Counterparty } from "../domain/reference-data.js";

const effectLabels: Record<Allocation["fundsEffect"], string> = {
  inflow: "資金流入",
  outflow: "資金流出",
  internal: "內部移轉",
  none: "不影響當下可動用資金",
};

const purposeLabels: Record<Allocation["purpose"], string> = {
  income: "收入",
  expense: "支出",
  transfer: "轉帳",
  refund: "退款",
  advance: "代墊",
  advance_recovery: "代墊收回",
  loan_out: "借出",
  loan_in: "借入",
  loan_repayment: "還款",
  fee: "手續費",
};

/**
 * 配置區塊的樹狀縮排版型（版型 D，見 docs/design/preview-layouts.md）：每筆配置佔兩行，
 * 第一行「資金效果 · 用途 (交易對象)」，第二行縮排列出分類與金額，讓多筆配置（例如
 * 多人分帳）在視覺上彼此分開，不會擠成一團難以辨讀。
 *
 * 層級用可見前綴「└」表達，不用空白縮排。純文字訊息沒有辦法要求 Telegram 把空白算成
 * 特定寬度：人工驗收實測，即使送出的是全形空格 U+3000，客戶端仍以半形寬度描繪，縮排
 * 因此縮水且無法預測（要保證等寬只能整塊改用 <pre>，那得改成 HTML parse_mode 並跳脫
 * 使用者輸入的分類與交易對象名稱）。可見字元不會被壓縮也不會被折疊，每一行都從同一個
 * 位置開始，層級就穩定了。
 *
 * 預覽與 `/recent` 共用同一份：兩邊各寫一份的時候，`/recent` 一直停在 M2 的
 * 「配置 N：用途・分類」舊格式，使用者在同一個 bot 裡會看到兩種排版。
 */
export function formatAllocationLines(
  allocations: readonly Allocation[],
  counterparties?: readonly Counterparty[],
): string[] {
  return allocations.flatMap((allocation) => {
    const category = allocation.subcategory
      ? `${allocation.category}／${allocation.subcategory}`
      : allocation.category;
    // 代墊與代墊收回都掛著各自的交易對象；多人分帳時若不逐筆顯示，
    // 使用者在確認前完全看不出哪一筆是指派給誰，選錯也不會發現。
    const counterpartyName = allocation.counterpartyId
      ? (counterparties?.find((item) => item.counterpartyId === allocation.counterpartyId)?.name ??
        allocation.counterpartyId)
      : undefined;
    return [
      `${effectLabels[allocation.fundsEffect]} · ${purposeLabels[allocation.purpose]}${counterpartyName ? ` (${counterpartyName})` : ""}`,
      `└ ${category} · ${allocation.amount.currency} ${allocation.amount.amount}`,
    ];
  });
}
