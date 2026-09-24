const SEPARATORS = /[,，、\n]/;
const HAS_AMOUNT = /\d/;

// 純粹的欠款／代付子句不能獨立成為一筆交易，必須併回前一段：「小明欠 630」
// 本身有金額數字，但那不是使用者付出去的錢，而是依附前一段總額的分帳明細。
// 「午餐 1260，小明欠 630」是一筆分帳，不是兩筆交易——若只用「含不含金額」判斷
// 是否能獨立成段，這筆會被錯誤切成兩段，代墊語意整個消失（見 m3b-acceptance.md
// 已知限制的追蹤紀錄）。嚴格錨定整串：只有「整段就是一個欠款／代付子句」才併回，
// 「小明欠 630 加小費 50」這種含其他內容的段落不在此列，仍視為可能獨立的交易。
const OWE_CLAUSE =
  /^[^\s，,、]{1,10}(?:欠|要還|該給)\s*[0-9]+(?:\.[0-9]+)?$|^幫\s*[^\s，,、]{1,10}\s*付\s*[0-9]+(?:\.[0-9]+)?$/;

function cannotStandAlone(segment: string): boolean {
  return !HAS_AMOUNT.test(segment) || OWE_CLAUSE.test(segment);
}

export function splitInput(text: string): string[] {
  const segments = text
    .split(SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const merged: string[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (cannotStandAlone(segment) && previous !== undefined) {
      merged[merged.length - 1] = `${previous}，${segment}`;
      continue;
    }
    merged.push(segment);
  }

  const [first, second, ...rest] = merged;
  if (first !== undefined && second !== undefined && cannotStandAlone(first)) {
    return [`${first}，${second}`, ...rest];
  }
  return merged;
}
