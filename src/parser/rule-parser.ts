import {
  TransactionDraftSchema,
  type Allocation,
  type TransactionDraft,
} from "../domain/ledger.js";
import { Decimal } from "decimal.js";
import type { ParseField, PartialAllocation, PartialDraft } from "../domain/draft.js";
import { money, type Money } from "../domain/money.js";
import type { Account, Category, Counterparty, Merchant } from "../domain/reference-data.js";
import { parseShare } from "./split-share.js";

export type { ParseField };

export interface ParseContext {
  readonly ownerId: string;
  readonly requestId: string;
  readonly sourceEventId: string;
  readonly draftId: string;
  readonly allocationId: string;
  readonly additionalAllocationId?: string;
  readonly today: string;
  readonly accounts?: readonly Account[];
  readonly categories?: readonly Category[];
  readonly merchants?: readonly Merchant[];
  readonly counterparties?: readonly Counterparty[];
  readonly advanceAllocationIds?: readonly string[];
}

export type ParseResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | {
      readonly kind: "missing_fields";
      readonly fields: readonly ParseField[];
      readonly partial: PartialDraft;
    }
  | {
      readonly kind: "ambiguous";
      readonly field: ParseField;
      readonly candidateIds: readonly string[];
      readonly partial: PartialDraft;
    };

interface AmountCandidate {
  value: string;
  index: number;
  signed: boolean;
}

export function parseAmountCandidates(text: string): AmountCandidate[] {
  return [...text.matchAll(/[+-]?\d+(?:\.\d+)?/g)].map((match) => ({
    value: match[0].replace(/^\+/, ""),
    index: match.index,
    signed: /^[+-]/.test(match[0]),
  }));
}

export function parseRelativeDate(text: string, today: string): string {
  if (!text.includes("昨天")) return today;
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function matchingReferences<T extends { name: string }>(text: string, values: readonly T[]): T[] {
  const matches = values.filter((value) => text.includes(value.name));
  return matches
    .filter(
      (candidate) =>
        !matches.some(
          (other) =>
            other.name !== candidate.name &&
            other.name.length > candidate.name.length &&
            other.name.includes(candidate.name) &&
            text.indexOf(other.name) === text.indexOf(candidate.name),
        ),
    )
    .toSorted((left, right) => text.indexOf(left.name) - text.indexOf(right.name));
}

function category(
  context: ParseContext,
  key: string,
  fallback: string,
): Pick<Allocation, "categoryId" | "category"> {
  const match = context.categories?.find((item) => item.key === key && item.active);
  return { ...(match ? { categoryId: match.categoryId } : {}), category: match?.name ?? fallback };
}

function draft(
  context: ParseContext,
  text: string,
  allocations: Allocation[],
  options: Pick<TransactionDraft, "accountFromId" | "accountToId" | "merchantId"> = {},
): ParseResult {
  const total = allocations
    .reduce((sum, item) => sum.plus(item.amount.amount), new Decimal(0))
    .toString();
  return {
    kind: "draft",
    draft: TransactionDraftSchema.parse({
      draftId: context.draftId,
      ownerId: context.ownerId,
      requestId: context.requestId,
      sourceEventId: context.sourceEventId,
      occurredDate: parseRelativeDate(text, context.today),
      amount: money(total, "TWD"),
      allocations,
      ...options,
      // 保存原文片段，/pending 的清單才看得出這筆是什麼。
      rawInputSnapshot: text,
      status: "awaiting_confirmation",
    }),
  };
}

function expenseShell(
  context: ParseContext,
  text: string,
  account: Account | undefined,
  merchant: Merchant | undefined,
  amount?: Money,
): PartialAllocation[] {
  const isLunch = text.includes("午餐");
  // 與正式草稿路徑相同的判斷：沒有任何參照也不是午餐時，無從決定用途。
  if (!isLunch && !merchant && !account) return [];
  const knownMerchant = merchant?.name === "Uber";
  const categoryKey = knownMerchant ? "expense_transport" : "expense_dining_lunch";
  const categoryFallback = knownMerchant ? "交通" : "餐飲";
  return [
    {
      allocationId: context.allocationId,
      fundsEffect: account?.type === "credit_card" ? "none" : "outflow",
      purpose: "expense",
      ...(amount ? { amount } : {}),
      ...category(context, categoryKey, categoryFallback),
      ...(isLunch ? { subcategory: "午餐" } : {}),
    },
  ];
}

/**
 * 用途無從判斷、但金額已知時的後援配置殼：留下一筆沒有 categoryId 的「待分類」
 * 支出配置，使用者補完分類就能升級成草稿。分帳與非分帳兩條路徑共用同一份建構
 * 方式——分帳路徑少了它，`聚餐 1260，我先付，朋友欠一半` 會因為配置為空而被
 * create-batch 判成完全無法解析，連草稿都不建（AC-11 直接掛掉）。
 */
function fallbackExpenseShell(
  context: ParseContext,
  account: Account | undefined,
  amount?: Money,
): PartialAllocation {
  return {
    allocationId: context.allocationId,
    fundsEffect: account?.type === "credit_card" ? "none" : "outflow",
    purpose: "expense",
    ...(amount ? { amount } : {}),
    category: "待分類",
  };
}

/**
 * 依「名字＋金額」清單建立代墊配置。explicit（`小明欠 630`）、可整除平分與
 * 除不盡的 placeholder 三處共用：三者的差別只在金額有沒有值。
 * 金額未給時必須把殼上的金額拿掉——殼的金額是交易總額，直接沿用會讓每一筆
 * placeholder 都背著全額，使用者補完每人負擔後總額會被加倍。
 */
function advanceAllocations(
  context: ParseContext,
  shell: PartialAllocation,
  shares: readonly { readonly name: string; readonly amount?: string }[],
): PartialAllocation[] {
  return shares.map((item, index) => {
    const counterparty = matchingReferences(item.name, context.counterparties ?? [])[0];
    const allocation: PartialAllocation = {
      ...shell,
      allocationId:
        context.advanceAllocationIds?.[index] ?? `${context.allocationId}-advance-${String(index)}`,
      purpose: "advance",
      ...(counterparty ? { counterpartyId: counterparty.counterpartyId } : {}),
    };
    if (item.amount === undefined) delete allocation.amount;
    else allocation.amount = money(item.amount, "TWD");
    return allocation;
  });
}

function partialOf(
  context: ParseContext,
  text: string,
  overrides: Partial<PartialDraft> = {},
): PartialDraft {
  return {
    occurredDate: parseRelativeDate(text, context.today),
    rawSegment: text,
    allocations: [],
    ...overrides,
  };
}

function incomplete(
  context: ParseContext,
  text: string,
  fields: readonly ParseField[],
  overrides: Partial<PartialDraft> = {},
): ParseResult {
  return { kind: "missing_fields", fields, partial: partialOf(context, text, overrides) };
}

function ambiguous(
  context: ParseContext,
  text: string,
  field: ParseField,
  candidateIds: readonly string[],
): ParseResult {
  return { kind: "ambiguous", field, candidateIds, partial: partialOf(context, text) };
}

/** 解析到的帳戶／商家參照，兩條支出路徑共用同一份 partial 覆寫。 */
type ParsedReferences = { readonly accountFromId?: string; readonly merchantId?: string };

function refundGuard(
  context: ParseContext,
  text: string,
  references: ParsedReferences,
): ParseResult | undefined {
  if (!text.includes("退款")) return undefined;
  return incomplete(context, text, ["refundTarget", "category"], { ...references });
}

function cardWithoutAccountGuard(
  context: ParseContext,
  text: string,
  accounts: readonly Account[],
  references: ParsedReferences,
): ParseResult | undefined {
  if (!text.includes("卡") || accounts.length > 0) return undefined;
  return incomplete(context, text, ["account"], { ...references });
}

/**
 * 「退款」與「提到卡卻沒有可辨識帳戶」這兩道關卡與分帳無關，但對每一條支出
 * 路徑都必須成立。explicit 前置攔截（Ruling 10）排在金額關卡之前，連帶也排到
 * 了這兩道關卡之前；不在它的最前面補回來，`午餐 1260 刷卡，朋友欠 630` 會漏掉
 * 刷卡判斷而入成 outflow:advance，同語意的「朋友欠一半」卻會正確追問帳戶。
 */
function expenseGuards(
  context: ParseContext,
  text: string,
  accounts: readonly Account[],
  references: ParsedReferences,
): ParseResult | undefined {
  return (
    refundGuard(context, text, references) ??
    cardWithoutAccountGuard(context, text, accounts, references)
  );
}

export function parseTransaction(text: string, context: ParseContext): ParseResult {
  const amounts = parseAmountCandidates(text);
  const accounts = matchingReferences(text, context.accounts?.filter((item) => item.active) ?? []);
  const merchants = matchingReferences(
    text,
    context.merchants?.filter((item) => item.active) ?? [],
  );
  if (accounts.length > 2)
    return ambiguous(
      context,
      text,
      "account",
      accounts.map((item) => item.accountId),
    );

  const transfer = text.includes("轉") || (text.includes("繳") && text.includes("卡"));
  if (!transfer && accounts.length > 1) {
    return ambiguous(
      context,
      text,
      "account",
      accounts.map((item) => item.accountId),
    );
  }
  const feeIndex = text.indexOf("手續費");
  if (transfer) {
    const principal = amounts.find((item) => item.index < feeIndex || feeIndex < 0);
    const fee = feeIndex >= 0 ? amounts.find((item) => item.index > feeIndex) : undefined;
    if (!principal || (feeIndex >= 0 && !fee)) return incomplete(context, text, ["amount"]);
    if (accounts.length < 2) return incomplete(context, text, ["account"]);
    const allocations: Allocation[] = [
      {
        allocationId: context.allocationId,
        fundsEffect: text.includes("繳") ? "outflow" : "internal",
        purpose: "transfer",
        amount: money(principal.value, "TWD"),
        ...category(context, "transfer", "轉帳"),
      },
    ];
    if (fee) {
      if (!context.additionalAllocationId) return incomplete(context, text, ["amount"]);
      allocations.push({
        allocationId: context.additionalAllocationId,
        fundsEffect: "outflow",
        purpose: "fee",
        amount: money(fee.value, "TWD"),
        ...category(context, "expense_financial_fee", "金融費用"),
      });
    }
    const isCardPayment = text.includes("繳") && text.includes("卡");
    const fromMarker = text.indexOf("從");
    const sourceAccount = isCardPayment
      ? accounts.find((item) => text.indexOf(item.name) > fromMarker)
      : accounts[0];
    const destinationAccount = isCardPayment
      ? accounts.find((item) => item.accountId !== sourceAccount?.accountId)
      : accounts[1];
    return draft(context, text, allocations, {
      accountFromId: sourceAccount?.accountId,
      accountToId: destinationAccount?.accountId,
    });
  }

  const account = accounts[0];
  const merchant = merchants[0];
  const references = {
    ...(account ? { accountFromId: account.accountId } : {}),
    ...(merchant ? { merchantId: merchant.merchantId } : {}),
  };

  // 不等額分帳（「小明欠 630」）是唯一能表達「每人負擔不同」的輸入方式，必須在
  // 「僅接受單一金額」的關卡之前攔截，否則指名金額造成的第二個數字會先被那道關卡擋下。
  // 條件嚴格限縮：只有文字中的數字數量剛好等於「總額 + 每筆指名代墊金額」時才接手，
  // 像「午餐 120 另加 30」這種沒有「欠」等分帳語句的句子，仍交回既有的金額關卡處理。
  const explicitShare = parseShare(text, amounts[0]?.value ?? "0");
  if (explicitShare.kind === "explicit" && amounts.length === explicitShare.shares.length + 1) {
    const guarded = expenseGuards(context, text, accounts, references);
    if (guarded) return guarded;

    const total = money(amounts[0]?.value ?? "", "TWD");
    const matched = expenseShell(context, text, account, merchant, total)[0];
    const shell = matched ?? fallbackExpenseShell(context, account, total);
    // 用了後援殼就沒有分類，草稿不能直接成立；把「待補分類」一路帶到底。
    const pendingCategory: ParseField[] = matched ? [] : ["category"];

    const advances = advanceAllocations(context, shell, explicitShare.shares);

    const advanceTotal = advances.reduce(
      (sum, item) => sum.plus(item.amount?.amount ?? "0"),
      new Decimal(0),
    );
    const personal = new Decimal(total.amount).minus(advanceTotal);

    // 代墊合計超過總額：語句自相矛盾，改為追問代墊金額，而不是產生負數配置。
    if (personal.isNegative()) {
      return incomplete(context, text, [...pendingCategory, "advanceShare"], {
        allocations: [{ ...shell, amount: total }, ...advances],
        ...references,
      });
    }

    // 個人負擔為 0 代表整筆都是代墊，不產生金額為 0 的個人配置（金額必須為正）。
    const allocations = personal.greaterThan(0)
      ? [{ ...shell, amount: money(personal.toString(), "TWD") }, ...advances]
      : advances;

    const missingCounterparty = advances.some((item) => !item.counterpartyId);
    if (missingCounterparty || pendingCategory.length > 0) {
      return incomplete(
        context,
        text,
        [...pendingCategory, ...(missingCounterparty ? (["counterparty"] as const) : [])],
        { allocations, ...references },
      );
    }
    return draft(context, text, allocations as Allocation[], references);
  }

  if (amounts.length !== 1) {
    return incomplete(context, text, ["amount"], {
      allocations: expenseShell(context, text, account, merchant),
      ...references,
    });
  }
  const amount = money(amounts[0]?.value ?? "", "TWD");
  const refund = refundGuard(context, text, references);
  if (refund) return refund;
  if (amounts[0]?.signed && text.includes("薪水")) {
    return draft(context, text, [
      {
        allocationId: context.allocationId,
        fundsEffect: "inflow",
        purpose: "income",
        amount,
        ...category(context, "income_salary", "薪資"),
      },
    ]);
  }
  const cardWithoutAccount = cardWithoutAccountGuard(context, text, accounts, references);
  if (cardWithoutAccount) return cardWithoutAccount;

  const share = parseShare(text, amount.amount);
  if (share.kind !== "none") {
    const matched = expenseShell(context, text, account, merchant, amount)[0];
    const shell = matched ?? fallbackExpenseShell(context, account, amount);
    // 用了後援殼就沒有分類，草稿不能直接成立；把「待補分類」一路帶到底。
    const pendingCategory: ParseField[] = matched ? [] : ["category"];

    if (share.kind === "not_divisible") {
      // 依人數產生 N−1 筆代墊 placeholder。只產生一筆會讓「三個人平分」補完金額後
      // 少算一個人的欠款，個人負擔也隨之多算——而且不會有任何測試抓到。
      // placeholder 不帶金額（由 advanceAllocations 負責移除），金額留給
      // applyAdvanceShare 在使用者回答後填入，加總時 undefined 視為 0。
      const placeholders = advanceAllocations(
        context,
        shell,
        Array.from({ length: share.participants - 1 }, (_, index) => ({
          name: share.names[index] ?? "",
        })),
      );
      // 一次宣告所有已知缺漏：名字不足時 placeholder 沒有 counterpartyId，
      // 答完 advanceShare 之後還得繼續追問 counterparty，不能等到那時候才發現。
      const fields: ParseField[] = [
        ...pendingCategory,
        "advanceShare",
        ...(placeholders.some((item) => !item.counterpartyId) ? (["counterparty"] as const) : []),
      ];
      return incomplete(context, text, fields, {
        allocations: [{ ...shell, amount }, ...placeholders],
        ...references,
      });
    }

    // 可整除但沒有具名時（逗號列舉，Ruling 4 刻意不當名字），仍要依人數建立代墊
    // placeholder，否則分帳意圖會整個消失，變成一筆全額的個人支出。§5.3 假設代墊
    // 配置已經存在，缺的只是 counterpartyId，所以這裡固定產生 N−1 筆、都帶上金額。
    const requested =
      share.kind === "explicit"
        ? share.shares
        : Array.from({ length: share.participants - 1 }, (_, index) => ({
            name: share.names[index] ?? "",
            amount: share.share,
          }));
    const expected = share.kind === "explicit" ? requested.length : share.participants - 1;

    const advances = advanceAllocations(context, shell, requested);

    const advanceTotal = advances.reduce(
      (sum, item) => sum.plus(item.amount?.amount ?? "0"),
      new Decimal(0),
    );
    const personal = new Decimal(amount.amount).minus(advanceTotal);
    // 個人負擔為 0（例如整筆金額只以「X欠<全額>」表達）時不產生金額為 0 的個人配置。
    const allocations = personal.greaterThan(0)
      ? [{ ...shell, amount: money(personal.toString(), "TWD") }, ...advances]
      : advances;

    const missingCounterparty =
      requested.length < expected || advances.some((item) => !item.counterpartyId);
    if (missingCounterparty || pendingCategory.length > 0) {
      return incomplete(
        context,
        text,
        [...pendingCategory, ...(missingCounterparty ? (["counterparty"] as const) : [])],
        { allocations, ...references },
      );
    }
    return draft(context, text, allocations as Allocation[], references);
  }

  const shell = expenseShell(context, text, account, merchant, amount);
  if (shell.length === 0) {
    // 用途無從判斷，但金額已知：留下沒有 categoryId 的配置殼，讓使用者補分類。
    return incomplete(context, text, ["category"], {
      allocations: [fallbackExpenseShell(context, account, amount)],
      ...references,
    });
  }
  return draft(context, text, shell as Allocation[], references);
}
