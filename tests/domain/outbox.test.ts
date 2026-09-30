import { describe, expect, it } from "vitest";

import { MAX_ATTEMPTS, backoffMs } from "../../src/domain/outbox.js";

describe("backoffMs", () => {
  it("grows threefold from five seconds and caps at five minutes", () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(15_000);
    expect(backoffMs(3)).toBe(45_000);
    expect(backoffMs(4)).toBe(135_000);
    expect(backoffMs(5)).toBe(300_000);
  });

  it("never exceeds the cap however many attempts have happened", () => {
    expect(backoffMs(99)).toBe(300_000);
  });

  it("gives up after five attempts, roughly eight minutes in total", () => {
    // 撐得過去的是網路抖動與 Telegram 短暫故障，那是秒到分鐘的量級。真的斷線時
    // long polling 也收不到訊息，outbox 不是承受長時間斷線的正確層級。
    expect(MAX_ATTEMPTS).toBe(5);
    const total = [1, 2, 3, 4, 5].reduce((sum, attempt) => sum + backoffMs(attempt), 0);
    expect(total).toBeLessThan(10 * 60_000);
    expect(total).toBeGreaterThan(7 * 60_000);
  });
});
