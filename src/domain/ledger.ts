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
  category: z.string().min(1),
  subcategory: z.string().min(1).optional(),
});
export type Allocation = z.infer<typeof AllocationSchema>;

const LedgerEntrySchema = z.object({
  ownerId: z.string().min(1),
  requestId: z.string().min(1),
  sourceEventId: z.string().min(1),
  occurredDate: z.iso.date(),
  amount: MoneySchema,
  allocations: z.array(AllocationSchema).min(1),
});

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
}

export const TransactionDraftSchema = LedgerEntrySchema.extend({
  draftId: z.string().min(1),
  status: z.enum(["awaiting_input", "awaiting_confirmation", "cancelled", "confirmed"]),
}).superRefine(validateAllocations);
export type TransactionDraft = z.infer<typeof TransactionDraftSchema>;

export const ConfirmedTransactionSchema = LedgerEntrySchema.extend({
  transactionId: z.string().min(1),
  draftId: z.string().min(1),
  confirmedAt: z.iso.datetime(),
  status: z.literal("confirmed"),
}).superRefine(validateAllocations);
export type ConfirmedTransaction = z.infer<typeof ConfirmedTransactionSchema>;
