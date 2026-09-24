import { Decimal } from "decimal.js";

import type { Counterparty } from "../domain/reference-data.js";

export type ShareResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "split";
      readonly participants: number;
      readonly names: readonly string[];
      readonly share: string;
    }
  | { readonly kind: "explicit"; readonly shares: readonly { name: string; amount: string }[] }
  | { readonly kind: "not_divisible"; readonly participants: number; readonly names: readonly string[] };

const CHINESE_DIGITS = new Map([
  ["一", 1],
  ["二", 2],
  ["兩", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
  ["十", 10],
]);

const COUNT_PATTERN = /([0-9]+|[一二兩三四五六七八九十])\s*個?\s*人\s*平分/;
const HALF_PATTERN = /(一半|各半|平分)/;
const EXPLICIT_PATTERN = /([^\s，,、]{1,10}?)欠\s*([0-9]+(?:\.[0-9]+)?)/g;
const OWES_PATTERN = /([^\s，,、]{1,10}?)(?:欠|要還|該給)/g;
const PAYS_FOR_PATTERN = /幫\s*([^\s，,、]{1,10}?)\s*付/g;
const SELF_WORDS = new Set(["我", "我先付", "自己"]);

function participantCount(text: string): number {
  const match = COUNT_PATTERN.exec(text);
  if (!match) return 2;
  const token = match[1] ?? "";
  const chinese = CHINESE_DIGITS.get(token);
  return chinese ?? Number(token);
}

function extractNames(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of [OWES_PATTERN, PAYS_FOR_PATTERN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const name = (match[1] ?? "").trim();
      if (name && !SELF_WORDS.has(name) && !/^[0-9.]+$/.test(name)) names.add(name);
      match = pattern.exec(text);
    }
  }
  return [...names];
}

export function parseShare(text: string, total: string): ShareResult {
  EXPLICIT_PATTERN.lastIndex = 0;
  const explicit: { name: string; amount: string }[] = [];
  let explicitMatch = EXPLICIT_PATTERN.exec(text);
  while (explicitMatch) {
    const name = (explicitMatch[1] ?? "").trim();
    const amount = explicitMatch[2] ?? "";
    if (name && !SELF_WORDS.has(name)) explicit.push({ name, amount });
    explicitMatch = EXPLICIT_PATTERN.exec(text);
  }
  if (explicit.length > 0) return { kind: "explicit", shares: explicit };

  if (!HALF_PATTERN.test(text) && !COUNT_PATTERN.test(text)) return { kind: "none" };

  const participants = participantCount(text);
  const names = extractNames(text);
  const shares = new Decimal(total).dividedBy(participants);
  if (!shares.times(participants).equals(new Decimal(total)) || shares.decimalPlaces() > 0) {
    return { kind: "not_divisible", participants, names };
  }
  return { kind: "split", participants, names, share: shares.toString() };
}

// 兩種寫法各自錨定整串：`小明還 300`（含還字）與 `收到小明 300`（收到前綴、
// 不需還字）。結尾都必須是純數字金額，避免「小明還欠我錢」這類敘述誤判成
// 回收語句。第一條的替代順序把「還我」「歸還」排在「還」之前，否則
// 「小明還我 300」會被「還」先吃掉、名字變成「小明」而剩下「我 300」對不上。
const REPAYMENT_PATTERNS = [
  /^(.+?)\s*(?:還我|歸還|還)\s*([0-9]+(?:\.[0-9]+)?)$/,
  /^收到\s*(.+?)\s*([0-9]+(?:\.[0-9]+)?)$/,
];

export function parseRepayment(
  text: string,
  counterparties: readonly Counterparty[],
): { counterpartyId: string; amount: string } | null {
  const trimmed = text.trim();
  for (const pattern of REPAYMENT_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const name = (match[1] ?? "").trim();
    const counterparty = counterparties.find((item) => item.name === name);
    if (!counterparty) return null;
    return { counterpartyId: counterparty.counterpartyId, amount: match[2] ?? "" };
  }
  return null;
}
