import { Decimal } from "decimal.js";
import { z } from "zod";

const AmountSchema = z.string().transform((value, context) => {
  let decimal: Decimal;

  try {
    decimal = new Decimal(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "money amount must be positive",
    });
    return z.NEVER;
  }

  if (!decimal.isFinite() || !decimal.greaterThan(0)) {
    context.addIssue({
      code: "custom",
      message: "money amount must be positive",
    });
    return z.NEVER;
  }

  return decimal.toString();
});

export const MoneySchema = z.object({
  amount: AmountSchema,
  currency: z.literal("TWD"),
});

export type Money = z.output<typeof MoneySchema>;

export function money(value: string, currency: "TWD"): Money {
  return MoneySchema.parse({ amount: value, currency });
}

export function addMoney(left: Money, right: Money): Money {
  return money(new Decimal(left.amount).plus(right.amount).toString(), left.currency);
}
