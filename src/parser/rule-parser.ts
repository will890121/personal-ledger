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
    const total = money(amounts[0]?.value ?? "", "TWD");
    const shell = expenseShell(context, text, account, merchant, total)[0];
    if (!shell) return incomplete(context, text, ["category"], { ...references });

    const advances = explicitShare.shares.map((item, index) => {
      const counterparty = matchingReferences(item.name, context.counterparties ?? [])[0];
      return {
        ...shell,
        allocationId:
          context.advanceAllocationIds?.[index] ??
          `${context.allocationId}-advance-${String(index)}`,
        purpose: "advance" as const,
        amount: money(item.amount, "TWD"),
        ...(counterparty ? { counterpartyId: counterparty.counterpartyId } : {}),
      };
    });

    const advanceTotal = advances.reduce(
      (sum, item) => sum.plus(item.amount.amount),
      new Decimal(0),
    );
    const personal = new Decimal(total.amount).minus(advanceTotal);

    // 代墊合計超過總額：語句自相矛盾，改為追問代墊金額，而不是產生負數配置。
    if (personal.isNegative()) {
      return incomplete(context, text, ["advanceShare"], {
        allocations: [{ ...shell, amount: total }, ...advances],
        ...references,
      });
    }

    // 個人負擔為 0 代表整筆都是代墊，不產生金額為 0 的個人配置（金額必須為正）。
    const allocations = personal.greaterThan(0)
      ? [{ ...shell, amount: money(personal.toString(), "TWD") }, ...advances]
      : advances;

    if (advances.some((item) => !item.counterpartyId)) {
      return incomplete(context, text, ["counterparty"], { allocations, ...references });
    }
    return draft(context, text, allocations, references);
  }

  if (amounts.length !== 1) {
    return incomplete(context, text, ["amount"], {
      allocations: expenseShell(context, text, account, merchant),
      ...references,
    });
  }
  const amount = money(amounts[0]?.value ?? "", "TWD");
  if (text.includes("退款"))
    return incomplete(context, text, ["refundTarget", "category"], { ...references });
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
  if (text.includes("卡") && accounts.length === 0)
    return incomplete(context, text, ["account"], { ...references });

  const share = parseShare(text, amount.amount);
  if (share.kind !== "none") {
    const shell = expenseShell(context, text, account, merchant, amount)[0];
    if (!shell) return incomplete(context, text, ["category"], { ...references });

    if (share.kind === "not_divisible") {
      // 依人數產生 N−1 筆代墊 placeholder。只產生一筆會讓「三個人平分」補完金額後
      // 少算一個人的欠款，個人負擔也隨之多算——而且不會有任何測試抓到。
      // placeholder 不能帶 amount：shell.amount 是交易總額，若直接展開會讓每一筆
      // placeholder 都背著全額，使用者補完每人負擔後總額會被加倍甚至更多。
      // 金額留給 applyAdvanceShare 在使用者回答後填入，加總時 undefined 視為 0。
      const shellWithoutAmount = { ...shell };
      delete shellWithoutAmount.amount;
      const placeholders = Array.from({ length: share.participants - 1 }, (_, index) => {
        const counterparty = matchingReferences(
          share.names[index] ?? "",
          context.counterparties ?? [],
        )[0];
        return {
          ...shellWithoutAmount,
          allocationId:
            context.advanceAllocationIds?.[index] ??
            `${context.allocationId}-advance-${String(index)}`,
          purpose: "advance" as const,
          ...(counterparty ? { counterpartyId: counterparty.counterpartyId } : {}),
        };
      });
      return incomplete(context, text, ["advanceShare"], {
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

    const resolved = requested.map((item) => ({
      ...item,
      counterparty: matchingReferences(item.name, context.counterparties ?? [])[0],
    }));

    const advances = resolved.map((item, index) => ({
      ...shell,
      allocationId:
        context.advanceAllocationIds?.[index] ?? `${context.allocationId}-advance-${String(index)}`,
      purpose: "advance" as const,
      amount: money(item.amount, "TWD"),
      ...(item.counterparty ? { counterpartyId: item.counterparty.counterpartyId } : {}),
    }));

    const advanceTotal = advances.reduce(
      (sum, item) => sum.plus(item.amount.amount),
      new Decimal(0),
    );
    const personal = new Decimal(amount.amount).minus(advanceTotal);
    // 個人負擔為 0（例如整筆金額只以「X欠<全額>」表達）時不產生金額為 0 的個人配置。
    const allocations = personal.greaterThan(0)
      ? [{ ...shell, amount: money(personal.toString(), "TWD") }, ...advances]
      : advances;

    if (resolved.length < expected || advances.some((item) => !item.counterpartyId)) {
      return incomplete(context, text, ["counterparty"], { allocations, ...references });
    }
    return draft(context, text, allocations, references);
  }

  const shell = expenseShell(context, text, account, merchant, amount);
  if (shell.length === 0) {
    // 用途無從判斷，但金額已知：留下沒有 categoryId 的配置殼，讓使用者補分類。
    return incomplete(context, text, ["category"], {
      allocations: [
        {
          allocationId: context.allocationId,
          fundsEffect: account?.type === "credit_card" ? "none" : "outflow",
          purpose: "expense",
          amount,
          category: "待分類",
        },
      ],
      ...references,
    });
  }
  return draft(context, text, shell as Allocation[], references);
}
