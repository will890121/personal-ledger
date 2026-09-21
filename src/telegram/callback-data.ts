import type { ParseField } from "../domain/draft.js";

export const CALLBACK_DATA_LIMIT = 64;

export type CallbackAction =
  | {
      readonly kind: "answer";
      readonly draftRef: string;
      readonly field: ParseField;
      readonly index: number;
    }
  | { readonly kind: "apply-amount"; readonly draftRef: string; readonly amount: string }
  | { readonly kind: "pending-page"; readonly status: "input" | "confirm"; readonly page: number }
  | { readonly kind: "pending-open"; readonly draftRef: string }
  | { readonly kind: "archive"; readonly draftRef: string };

const fieldCodes: Record<ParseField, string> = {
  amount: "amt",
  category: "cat",
  account: "acc",
  refundTarget: "ref",
  purpose: "pur",
};
const fieldsByCode = new Map<string, ParseField>(
  Object.entries(fieldCodes).map(([field, code]) => [code, field as ParseField]),
);

const REF_PATTERN = /^[0-9a-f]{8}$/;
const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
const INDEX_PATTERN = /^\d{1,2}$/;

function guard(data: string): string {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_LIMIT) {
    throw new Error("callback data exceeds telegram limit");
  }
  return data;
}

export function encodeCallback(action: CallbackAction): string {
  switch (action.kind) {
    case "answer":
      return guard(`a:${action.draftRef}:${fieldCodes[action.field]}:${String(action.index)}`);
    case "apply-amount":
      return guard(`v:${action.draftRef}:${action.amount}`);
    case "pending-page":
      return guard(`p:${action.status}:${String(action.page)}`);
    case "pending-open":
      return guard(`o:${action.draftRef}`);
    case "archive":
      return guard(`z:${action.draftRef}`);
  }
}

export function decodeCallback(data: string): CallbackAction | null {
  const [prefix, first, second, third] = data.split(":");

  if (prefix === "a" && first !== undefined && second !== undefined && third !== undefined) {
    const field = fieldsByCode.get(second);
    if (!REF_PATTERN.test(first) || !field || !INDEX_PATTERN.test(third)) return null;
    return { kind: "answer", draftRef: first, field, index: Number(third) };
  }
  if (prefix === "v" && first !== undefined && second !== undefined) {
    if (!REF_PATTERN.test(first) || !AMOUNT_PATTERN.test(second)) return null;
    return { kind: "apply-amount", draftRef: first, amount: second };
  }
  if (prefix === "p" && (first === "input" || first === "confirm") && second !== undefined) {
    if (!INDEX_PATTERN.test(second)) return null;
    return { kind: "pending-page", status: first, page: Number(second) };
  }
  if (prefix === "o" && first !== undefined) {
    if (!REF_PATTERN.test(first)) return null;
    return { kind: "pending-open", draftRef: first };
  }
  if (prefix === "z" && first !== undefined) {
    if (!REF_PATTERN.test(first)) return null;
    return { kind: "archive", draftRef: first };
  }
  return null;
}
