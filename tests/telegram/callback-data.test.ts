import { describe, expect, it } from "vitest";

import {
  CALLBACK_DATA_LIMIT,
  decodeCallback,
  encodeCallback,
  type CallbackAction,
} from "../../src/telegram/callback-data.js";

const samples: CallbackAction[] = [
  { kind: "answer", draftRef: "a7b2c9e4", field: "category", index: 9 },
  { kind: "answer", draftRef: "ffffffff", field: "refundTarget", index: 0 },
  { kind: "apply-amount", draftRef: "a7b2c9e4", amount: "123456.78" },
  { kind: "pending-page", status: "input", page: 3 },
  { kind: "pending-page", status: "confirm", page: 0 },
  { kind: "pending-open", draftRef: "a7b2c9e4" },
  { kind: "archive", draftRef: "a7b2c9e4" },
  { kind: "create-counterparty", draftRef: "a7b2c9e4" },
  { kind: "advance-recover", ref: "a7b2c9e4" },
  { kind: "advance-abandon", ref: "ffffffff" },
];

describe("callback data", () => {
  it("round-trips every action", () => {
    for (const action of samples) {
      expect(decodeCallback(encodeCallback(action))).toEqual(action);
    }
  });

  it("never exceeds the telegram callback data limit", () => {
    for (const action of samples) {
      expect(Buffer.byteLength(encodeCallback(action), "utf8")).toBeLessThanOrEqual(
        CALLBACK_DATA_LIMIT,
      );
    }
  });

  it("rejects an amount that would overflow the limit", () => {
    expect(() =>
      encodeCallback({ kind: "apply-amount", draftRef: "a7b2c9e4", amount: "1".repeat(64) }),
    ).toThrow();
  });

  it("returns null for unknown or malformed payloads", () => {
    expect(decodeCallback("confirm:00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(decodeCallback("a:a7b2c9e4:zzz:1")).toBeNull();
    expect(decodeCallback("a:NOTAREF:cat:1")).toBeNull();
    expect(decodeCallback("v:a7b2c9e4:abc")).toBeNull();
    expect(decodeCallback("")).toBeNull();
  });
  it("round-trips a cancel action keyed by draft ref", () => {
    // 預覽用的是舊的 `cancel:<draftId>`，而 draftId 是 UUID；追問訊息手上只有 8 碼
    // draftRef，也不該把 UUID 塞進 callback_data。
    const data = encodeCallback({ kind: "cancel", draftRef: "a7b2c9e4" });

    expect(data).toBe("x:a7b2c9e4");
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    expect(decodeCallback(data)).toEqual({ kind: "cancel", draftRef: "a7b2c9e4" });
    expect(decodeCallback("x:not-hex")).toBeNull();
  });
});
