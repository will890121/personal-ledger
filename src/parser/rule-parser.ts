import { TransactionDraftSchema, type TransactionDraft } from "../domain/ledger.js";
import { money } from "../domain/money.js";

export interface ParseContext {
  readonly ownerId: string;
  readonly requestId: string;
  readonly sourceEventId: string;
  readonly draftId: string;
  readonly allocationId: string;
  readonly today: string;
}

export type ParseResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | {
      readonly kind: "missing_fields";
      readonly fields: readonly ("amount" | "category")[];
    };

export function parseTransaction(text: string, context: ParseContext): ParseResult {
  const fields: ("amount" | "category")[] = [];
  const amountCandidates = text.match(/[+-]?\d+(?:\.\d+)?/g) ?? [];

  if (amountCandidates.length !== 1) {
    fields.push("amount");
  }
  if (!text.includes("午餐")) {
    fields.push("category");
  }
  if (fields.length > 0) {
    return { kind: "missing_fields", fields };
  }

  let amount;
  try {
    amount = money(amountCandidates[0] ?? "", "TWD");
  } catch {
    return { kind: "missing_fields", fields: ["amount"] };
  }

  return {
    kind: "draft",
    draft: TransactionDraftSchema.parse({
      draftId: context.draftId,
      ownerId: context.ownerId,
      requestId: context.requestId,
      sourceEventId: context.sourceEventId,
      occurredDate: context.today,
      amount,
      allocations: [
        {
          allocationId: context.allocationId,
          fundsEffect: "outflow",
          purpose: "expense",
          amount,
          category: "餐飲",
          subcategory: "午餐",
        },
      ],
      status: "awaiting_confirmation",
    }),
  };
}
