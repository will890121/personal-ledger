import { Decimal } from "decimal.js";
import { z } from "zod";

import { MoneySchema } from "./money.js";

export const FundsEffectSchema = z.enum(["inflow", "outflow", "internal", "none"]);
export type FundsEffect = z.infer<typeof FundsEffectSchema>;

export const PurposeSchema = z.enum([
  "income",
  "expense",
  "transfer",
  "refund",
  "advance",
  "advance_recovery",
  "loan_out",
  "loan_in",
  "loan_repayment",
  "fee",
]);
export type Purpose = z.infer<typeof PurposeSchema>;

export const AllocationSchema = z.object({
  allocationId: z.string().min(1),
  fundsEffect: FundsEffectSchema,
  purpose: PurposeSchema,
  amount: MoneySchema,
  categoryId: z.string().min(1).optional(),
  category: z.string().min(1),
  subcategory: z.string().min(1).optional(),
  counterpartyId: z.string().min(1).optional(),
  note: z.string().trim().min(1).optional(),
});
export type Allocation = z.infer<typeof AllocationSchema>;

const LedgerEntrySchema = z.object({
  ownerId: z.string().min(1),
  requestId: z.string().min(1),
  sourceEventId: z.string().min(1),
  sourceType: z.enum(["telegram", "system"]).optional(),
  sourceRef: z.string().min(1).optional(),
  occurredDate: z.iso.date(),
  occurredTime: z.iso.time().optional(),
  amount: MoneySchema,
  allocations: z.array(AllocationSchema).min(1),
  accountFromId: z.string().min(1).optional(),
  accountToId: z.string().min(1).optional(),
  merchantId: z.string().min(1).optional(),
  counterpartyId: z.string().min(1).optional(),
  tagIds: z.array(z.string().min(1)).optional(),
  note: z.string().trim().min(1).optional(),
  rawInputSnapshot: z.string().max(4_096).optional(),
});

const supportedAccountingShapes = new Set([
  "inflow:income",
  "outflow:expense",
  "none:expense",
  "internal:transfer",
  "outflow:transfer",
  "inflow:refund",
  "none:refund",
  "outflow:fee",
]);

function validateAllocations(
  value: z.infer<typeof LedgerEntrySchema>,
  context: z.RefinementCtx,
): void {
  const total = value.allocations.reduce(
    (sum, allocation) => sum.plus(allocation.amount.amount),
    new Decimal(0),
  );

  if (!total.equals(value.amount.amount)) {
    context.addIssue({
      code: "custom",
      message: "allocation total must equal transaction amount",
      path: ["allocations"],
    });
  }

  for (const [index, allocation] of value.allocations.entries()) {
    if (!supportedAccountingShapes.has(`${allocation.fundsEffect}:${allocation.purpose}`)) {
      context.addIssue({
        code: "custom",
        message: "unsupported accounting shape",
        path: ["allocations", index],
      });
    }
  }

  const hasInternalTransfer = value.allocations.some(
    (allocation) => allocation.fundsEffect === "internal" && allocation.purpose === "transfer",
  );
  if (
    hasInternalTransfer &&
    (!value.accountFromId || !value.accountToId || value.accountFromId === value.accountToId)
  ) {
    context.addIssue({
      code: "custom",
      message: "internal transfer requires distinct accounts",
      path: ["accountToId"],
    });
  }

  const hasCreditExpense = value.allocations.some(
    (allocation) => allocation.fundsEffect === "none" && allocation.purpose === "expense",
  );
  if (hasCreditExpense && value.accountToId) {
    context.addIssue({
      code: "custom",
      message: "credit expense cannot have a destination account",
      path: ["accountToId"],
    });
  }
}

export const TransactionDraftSchema = LedgerEntrySchema.extend({
  draftId: z.string().min(1),
  status: z.enum([
    "parsing",
    "awaiting_input",
    "awaiting_confirmation",
    "processing",
    "confirmed",
    "cancelled",
    "needs_attention",
    "archived",
  ]),
}).superRefine(validateAllocations);
export type TransactionDraft = z.infer<typeof TransactionDraftSchema>;

export const ConfirmedTransactionSchema = LedgerEntrySchema.extend({
  transactionId: z.string().min(1),
  draftId: z.string().min(1),
  confirmedAt: z.iso.datetime(),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  deletedAt: z.iso.datetime().optional(),
  status: z.enum(["confirmed", "deleted"]),
}).superRefine(validateAllocations);
export type ConfirmedTransaction = z.infer<typeof ConfirmedTransactionSchema>;
