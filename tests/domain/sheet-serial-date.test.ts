import { describe, expect, it } from "vitest";

import { fromSheetSerialDate, toSheetSerialDate } from "../../src/domain/sheet-serial-date.js";

describe("toSheetSerialDate", () => {
  it("maps the sheets epoch to zero", () => {
    // Sheets 的序列值原點是 1899-12-30（不是 1900-01-01，也不是 Unix epoch）。
    expect(toSheetSerialDate("1899-12-30")).toBe(0);
  });

  it("maps a known date to its serial value", () => {
    // 2026-10-01 距 1899-12-30 共 46296 天。這個數字若算錯，Sheet 上每一筆的日期
    // 都會整體平移，而且看起來仍像個合理的日期——不會有任何東西報錯。
    expect(toSheetSerialDate("2026-10-01")).toBe(46296);
  });

  it("is unaffected by the host timezone", () => {
    // occurred_date 是純日期字串，不帶時區。若實作用 new Date(iso) 再取 UTC 天數，
    // 在 UTC+8 的主機上跨日邊界會整批差一天。
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      expect(toSheetSerialDate("2026-10-01")).toBe(46296);
    } finally {
      process.env.TZ = previous;
    }
  });
});

describe("fromSheetSerialDate", () => {
  it("round-trips every date it is given, including a leap day", () => {
    // 這是那個 1899-12-30 原點常數唯一的守門人：兩個方向共用它，只要它被改動，
    // 來回一趟就對不回原本的日期。閏日單獨列出來，因為 2/29 是最容易被自製
    // 天數換算算錯的一天。
    for (const date of ["1899-12-30", "2024-02-29", "2026-10-01", "2026-09-28", "2100-03-01"]) {
      expect(fromSheetSerialDate(toSheetSerialDate(date))).toBe(date);
    }
  });
});
