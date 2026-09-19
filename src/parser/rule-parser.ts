import {
  TransactionDraftSchema,
  type Allocation,
  type TransactionDraft,
} from "../domain/ledger.js";
import { Decimal } from "decimal.js";
import { money } from "../domain/money.js";
import type { Account, Category, Merchant } from "../domain/reference-data.js";

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
}

export type ParseField = "amount" | "category" | "account" | "refundTarget" | "purpose";
export type ParseResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | { readonly kind: "missing_fields"; readonly fields: readonly ParseField[] }
  | {
      readonly kind: "ambiguous";
      readonly field: ParseField;
      readonly candidateIds: readonly string[];
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
      status: "awaiting_confirmation",
    }),
  };
}

export function parseTransaction(text: string, context: ParseContext): ParseResult {
  const amounts = parseAmountCandidates(text);
  const accounts = matchingReferences(text, context.accounts?.filter((item) => item.active) ?? []);
  const merchants = matchingReferences(
    text,
    context.merchants?.filter((item) => item.active) ?? [],
  );
  if (accounts.length > 2)
    return {
      kind: "ambiguous",
      field: "account",
      candidateIds: accounts.map((item) => item.accountId),
    };

  const transfer = text.includes("轉") || (text.includes("繳") && text.includes("卡"));
  if (!transfer && accounts.length > 1) {
    return {
      kind: "ambiguous",
      field: "account",
      candidateIds: accounts.map((item) => item.accountId),
    };
  }
  const feeIndex = text.indexOf("手續費");
  if (transfer) {
    const principal = amounts.find((item) => item.index < feeIndex || feeIndex < 0);
    const fee = feeIndex >= 0 ? amounts.find((item) => item.index > feeIndex) : undefined;
    if (!principal || (feeIndex >= 0 && !fee))
      return { kind: "missing_fields", fields: ["amount"] };
    if (accounts.length < 2) return { kind: "missing_fields", fields: ["account"] };
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
      if (!context.additionalAllocationId) return { kind: "missing_fields", fields: ["amount"] };
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

  if (amounts.length !== 1) return { kind: "missing_fields", fields: ["amount"] };
  const amount = money(amounts[0]?.value ?? "", "TWD");
  if (text.includes("退款"))
    return { kind: "missing_fields", fields: ["refundTarget", "category"] };
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
    return { kind: "missing_fields", fields: ["account"] };
  if (!text.includes("午餐") && merchants.length === 0 && accounts.length === 0) {
    return { kind: "missing_fields", fields: ["category"] };
  }
  const account = accounts[0];
  const merchant = merchants[0];
  const isLunch = text.includes("午餐");
  const categoryKey = merchant?.name === "Uber" ? "expense_transport" : "expense_dining_lunch";
  const categoryFallback = merchant?.name === "Uber" ? "交通" : "餐飲";
  return draft(
    context,
    text,
    [
      {
        allocationId: context.allocationId,
        fundsEffect: account?.type === "credit_card" ? "none" : "outflow",
        purpose: "expense",
        amount,
        ...category(context, categoryKey, categoryFallback),
        ...(isLunch ? { subcategory: "午餐" } : {}),
      },
    ],
    {
      ...(account ? { accountFromId: account.accountId } : {}),
      ...(merchant ? { merchantId: merchant.merchantId } : {}),
    },
  );
}
