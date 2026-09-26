import type { Account, Counterparty, Merchant } from "../domain/reference-data.js";
import { normalizeReferenceName } from "../domain/reference-data.js";
import { categoryKeywords } from "./category-keywords.js";

/**
 * 句子裡「解析器完全交代不出來」的那一段文字，用來提議成使用者自訂的分類關鍵字。
 *
 * 做法是剝除法：把金額、日期詞、已知帳戶／商家／交易對象名稱、內建與使用者關鍵字、
 * 分帳語句的關鍵字與所有標點空白都拿掉，剩下的就是候選詞。
 *
 * 這個函式永遠只是「提議」——它分不出「一蘭拉麵」是店名而「牛排」是品項，也分不出
 * 「雜支」兩者都不是。因此接受條件刻意保守，而且呼叫端必須讓「不用」比「記住」更省事。
 */

// 只有一個字的殘餘幾乎都是動詞或量詞（「國泰卡刷 1200」剝完只剩「刷」），當成品項太冒險。
const MIN_LENGTH = 2;
// 超過這個長度的多半是一整句描述，不是一個可以重複命中的詞。
const MAX_LENGTH = 12;

const DATE_WORDS = ["今天", "昨天", "前天", "本日", "當日"];
// 帶分帳或還款語句的句子另有追問要處理，殘餘文字也不會是店名（「聚餐 1260，小明欠 630」
// 剝完剩「聚餐」，但那句話的重點是分帳，不該在那裡插一則「要記住嗎」）。
const SHARE_MARKERS = [
  "欠",
  "先付",
  "平分",
  "一半",
  "各半",
  "還",
  "收到",
  "代墊",
  "幫",
  "要還",
  "該給",
];

// 金額單位不剝的話，「牛排 300元」剝完會剩兩段而永遠不提議；草稿本身解析正常，
// 所以對習慣寫「元」「塊」的使用者來說，這個功能是無聲失效的。
const AMOUNT_UNITS = ["NT$", "NTD", "元", "塊", "圓", "錢"];
// 把名稱從詞的中間剝掉會留下助詞開頭的碎片（「小明的生日禮物」→「的生日禮物」），
// 那則提議讀起來是壞的；動詞開頭（「買牛排」）則會讓關鍵字帶著動詞，下次只講「牛排」
// 仍然對不到。兩者都只修剪開頭，不改動詞本身。
const LEADING_NOISE = [
  "的",
  "了",
  "和",
  "跟",
  "與",
  "及",
  "買",
  "付",
  "花",
  "刷",
  "繳",
  "給",
  "去",
];

export interface ResidualReferences {
  readonly accounts?: readonly Account[];
  readonly merchants?: readonly Merchant[];
  readonly counterparties?: readonly Counterparty[];
  readonly userKeywords?: readonly { readonly keyword: string }[];
}

export function extractResidualKeyword(
  text: string,
  references: ResidualReferences,
): string | undefined {
  if (SHARE_MARKERS.some((marker) => text.includes(marker))) return undefined;

  let rest = text;
  const strip = (value: string): void => {
    if (value.length > 0) rest = rest.split(value).join(" ");
  };

  // 長的名稱先剝，否則短名稱會把長名稱切斷（「國泰卡」被「國泰」吃掉後剩一個「卡」）。
  const names = [
    ...(references.accounts ?? []).map((item) => item.name),
    ...(references.merchants ?? []).map((item) => item.name),
    ...(references.counterparties ?? []).map((item) => item.name),
    ...(references.userKeywords ?? []).map((item) => item.keyword),
    ...categoryKeywords.map((item) => item.keyword),
    ...DATE_WORDS,
  ].sort((a, b) => b.length - a.length);
  for (const name of names) strip(name);

  for (const unit of AMOUNT_UNITS) strip(unit);

  const residual = rest
    .replace(/[+-]?\d+(?:\.\d+)?/g, " ")
    .replace(/[\s,，、。：:；;（）()「」【】$%％/\\*+-]/g, " ")
    .trim();

  // 剝完若散成好幾段，代表這句話還有別的東西沒被解析，不是一個乾淨的候選詞。
  const parts = residual.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length !== 1) return undefined;

  let candidate = parts[0] ?? "";
  while (LEADING_NOISE.some((noise) => candidate.startsWith(noise))) {
    candidate = candidate.slice(1);
  }
  if (candidate.length < MIN_LENGTH || candidate.length > MAX_LENGTH) return undefined;
  if (/\d/.test(candidate)) return undefined;
  // 修剪之後才能確定它不是一個已經認得的詞（「買牛排」修成「牛排」就可能已經教過了）。
  const normalized = normalizeReferenceName(candidate);
  const known = [
    ...(references.userKeywords ?? []).map((item) => item.keyword),
    ...categoryKeywords.map((item) => item.keyword),
  ];
  if (known.some((word) => normalizeReferenceName(word) === normalized)) return undefined;
  return candidate;
}
