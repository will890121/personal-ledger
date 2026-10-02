import { describe, expect, it } from "vitest";

import {
  classifySheetFailure,
  describeSheetFailure,
  ESCALATE_AFTER_FAILURES,
} from "../../src/sheets/sheet-failure.js";

describe("classifySheetFailure", () => {
  it.each([429, 500, 502, 503, 504])("treats %i as transient", (status) => {
    expect(classifySheetFailure({ code: status })).toBe("transient");
  });

  it.each([400, 401, 403, 404])("treats %i as permanent", (status) => {
    // 403 是「試算表沒分享給服務帳號」，404 是「試算表被刪」。這兩種會無聲地
    // 永遠重試下去，必須升級成使用者看得到的通知，否則鏡像停了沒人知道。
    expect(classifySheetFailure({ code: status })).toBe("permanent");
  });

  it("reads the status code from response.status when code is absent", () => {
    // googleapis 的錯誤有時把狀態碼放在 response.status 而不是 code。
    expect(classifySheetFailure({ response: { status: 403 } })).toBe("permanent");
    expect(classifySheetFailure({ response: { status: 500 } })).toBe("transient");
  });

  it("treats a network error with no status as transient", () => {
    expect(classifySheetFailure(new Error("ETIMEDOUT"))).toBe("transient");
  });

  it("treats a non-object error as transient", () => {
    expect(classifySheetFailure("boom")).toBe("transient");
    expect(classifySheetFailure(undefined)).toBe("transient");
  });

  it("treats an unrecognised status code as transient", () => {
    // 分類表沒列到的狀態碼（例如 418）不是我們認得的永久性錯誤形狀。
    // 寧可多重試也不要誤判成永久而停掉鏡像。
    expect(classifySheetFailure({ code: 418 })).toBe("transient");
  });
});

describe("describeSheetFailure", () => {
  it("combines classification and status code", () => {
    expect(describeSheetFailure({ code: 403 })).toBe("permanent:403");
    expect(describeSheetFailure({ code: 503 })).toBe("transient:503");
  });

  it("falls back to unknown when there is no status code", () => {
    expect(describeSheetFailure(new Error("ETIMEDOUT"))).toBe("transient:unknown");
  });

  it("never contains the raw error message", () => {
    // Google 的錯誤可能夾帶試算表 id，本專案禁止把它寫進任何持久化欄位。
    const error = new Error("Spreadsheet abc123XYZ not found");
    expect(describeSheetFailure(error)).not.toContain("abc123XYZ");
    expect(describeSheetFailure(error)).not.toContain("Spreadsheet");
  });
});

describe("ESCALATE_AFTER_FAILURES", () => {
  it("is 5", () => {
    expect(ESCALATE_AFTER_FAILURES).toBe(5);
  });
});
