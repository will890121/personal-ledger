import { google } from "googleapis";
import { describe, expect, it, vi } from "vitest";

import type { SheetCell } from "../../src/domain/sheet-rows.js";
import {
  columnLetter,
  createGoogleSheetsClient,
  createSheetsClientForApi,
  type SheetsApiRequests,
} from "../../src/sheets/google-sheets-client.js";

// M-3：只在這個檔案裡把 googleapis 換成記錄器，用來斷言真正傳給 GoogleAuth
// 的 scopes——不能只斷言 SCOPES 這個常數本身的值，那樣的話同一次修改（把常數
// 改壞）會連斷言一起改壞，測試永遠是綠的。這裡繞過整個模組，直接看
// createGoogleSheetsClient 實際餵給 google.auth.GoogleAuth 建構子的參數。
vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: vi.fn().mockImplementation(() => ({})) },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: { get: vi.fn(), values: { get: vi.fn() }, batchUpdate: vi.fn() },
    }),
  },
}));

const SPREADSHEET = "spreadsheet-1";

interface RecordedApi {
  readonly api: SheetsApiRequests;
  readonly getSpreadsheetCalls: unknown[];
  readonly getValuesCalls: unknown[];
  readonly batchUpdateCalls: unknown[];
}

/**
 * 把三個原始請求換成記錄器。不用 mock 整個 googleapis：要驗的是「我們送出去的
 * 參數物件長什麼樣」，那一層剛好就是 SheetsApiRequests。
 */
function recordedApi(options: { values?: unknown[][]; tabs?: Record<string, number> } = {}) {
  const tabs = options.tabs ?? { Transactions: 11, Allocations: 22, MonthlySummary: 33 };
  const getSpreadsheetCalls: unknown[] = [];
  const getValuesCalls: unknown[] = [];
  const batchUpdateCalls: unknown[] = [];
  const api: SheetsApiRequests = {
    getSpreadsheet: (params) => {
      getSpreadsheetCalls.push(params);
      return Promise.resolve({
        data: {
          sheets: Object.entries(tabs).map(([title, sheetId]) => ({
            properties: { sheetId, title },
          })),
        },
      });
    },
    getValues: (params) => {
      getValuesCalls.push(params);
      return Promise.resolve({ data: { values: options.values ?? null } });
    },
    batchUpdate: (params) => {
      batchUpdateCalls.push(params);
      return Promise.resolve(undefined);
    },
  };
  return { api, getSpreadsheetCalls, getValuesCalls, batchUpdateCalls } satisfies RecordedApi;
}

describe("columnLetter", () => {
  it("maps column counts to A1 letters", () => {
    expect([1, 2, 13, 26, 27, 52].map(columnLetter)).toEqual(["A", "B", "M", "Z", "AA", "AZ"]);
  });

  it("rejects a non-positive column count", () => {
    expect(() => columnLetter(0)).toThrow(/positive/);
  });
});

describe("Google Sheets adapter：readColumns", () => {
  it("永遠帶 UNFORMATTED_VALUE 去讀", async () => {
    // Review Focus #1 的命脈。Google 的預設是 FORMATTED_VALUE，日期欄會回
    // "2026/9/28" 這種顯示字串；引擎對那一欄做的是 Number(raw)，於是拿到 NaN、
    // 舊日期被靜默丟棄、跨月搬移的舊月份摘要永遠不會被重算——而所有測試依然
    // 全綠，因為測試替身存的就是序列值。所以這裡逐字斷言整個參數物件：
    // 少了 valueRenderOption、或被改成別的值，這條就紅。
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await client.readColumns("Transactions", 2);

    expect(recorded.getValuesCalls).toEqual([
      {
        spreadsheetId: SPREADSHEET,
        range: "Transactions!A:B",
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
      },
    ]);
  });

  it("把日期欄的序列值原封不動交給引擎", async () => {
    // UNFORMATTED_VALUE 回來的是數字 46295，不是 "2026/9/28"。引擎的
    // DECIMAL_SERIAL 只接受純十進位數字，所以這裡必須是 "46295"。
    const recorded = recordedApi({
      values: [
        ["transaction_id", "日期"],
        ["t1", 46295],
      ],
    });
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await expect(client.readColumns("Transactions", 2)).resolves.toEqual([
      ["transaction_id", "日期"],
      ["t1", "46295"],
    ]);
  });

  it("把省略的尾端格子補成空字串", async () => {
    // Google 會省略尾端全空的格子，回來的列長度參差不齊。ports 的契約是
    // 「空格為空字串」，補齊是實作端的責任——引擎讀 row[1] 拿到 undefined 的話
    // `(row?.[1] ?? "")` 雖然擋得住，但那是兩層防護，不是契約。
    const recorded = recordedApi({ values: [["a"], [], ["c", null, true]] });
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await expect(client.readColumns("Allocations", 3)).resolves.toEqual([
      ["a", "", ""],
      ["", "", ""],
      ["c", "", "true"],
    ]);
  });

  it("整張分頁是空的時候回空陣列", async () => {
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await expect(client.readColumns("MonthlySummary", 1)).resolves.toEqual([]);
  });
});

describe("Google Sheets adapter：updateCells", () => {
  const cells: SheetCell[] = [
    { kind: "string", value: "=SUM(A1:A9)" },
    { kind: "number", value: 120.5 },
    { kind: "date", value: 46295 },
    { kind: "empty" },
  ];

  it("每一格都明確給型別，日期額外帶 DATE 數字格式", async () => {
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await client.updateCells([{ tab: "Transactions", rowIndex: 5, cells }]);

    expect(recorded.batchUpdateCalls).toEqual([
      {
        spreadsheetId: SPREADSHEET,
        requestBody: {
          requests: [
            {
              updateCells: {
                range: {
                  sheetId: 11,
                  // GridRange 是 0-based、結束值不含；rowIndex 5 就是這一列。
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 4,
                },
                rows: [
                  {
                    values: [
                      { userEnteredValue: { stringValue: "=SUM(A1:A9)" } },
                      { userEnteredValue: { numberValue: 120.5 } },
                      {
                        userEnteredValue: { numberValue: 46295 },
                        userEnteredFormat: { numberFormat: { type: "DATE" } },
                      },
                      {},
                    ],
                  },
                ],
                fields: "userEnteredValue,userEnteredFormat.numberFormat",
              },
            },
          ],
        },
      },
    ]);
  });

  it("備註以 = 開頭也只是字串，不會變成活的公式", async () => {
    // spec §4：USER_ENTERED 會把 "="、"+"、"-"、"@" 開頭的備註變成使用者試算表裡
    // 一條活的公式。明確給 stringValue 讓這件事在結構上不可能發生，所以這裡
    // 同時釘住「送出去的請求裡沒有任何 valueInputOption／USER_ENTERED」。
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await client.updateCells([
      { tab: "Allocations", rowIndex: 2, cells: [{ kind: "string", value: "=1+1" }] },
    ]);

    const sent = JSON.stringify(recorded.batchUpdateCalls);
    expect(sent).toContain('"stringValue":"=1+1"');
    expect(sent).not.toContain("valueInputOption");
    expect(sent).not.toContain("USER_ENTERED");
  });

  it("整批一次送出，不拆成多筆呼叫", async () => {
    // ports 的契約是全有全無。一次 batchUpdate 就是一筆原子請求；拆成多次呼叫
    // 會讓失敗停在半套用的狀態上，而「失敗就整輪重做」是建立在重做面對的是
    // 乾淨資料這個前提上。
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await client.updateCells([
      { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "a" }] },
      { tab: "Allocations", rowIndex: 3, cells: [{ kind: "string", value: "b" }] },
      { tab: "MonthlySummary", rowIndex: 4, cells: [{ kind: "string", value: "c" }] },
    ]);

    expect(recorded.batchUpdateCalls).toHaveLength(1);
    const requests = (recorded.batchUpdateCalls[0] as { requestBody: { requests: unknown[] } })
      .requestBody.requests;
    expect(requests).toHaveLength(3);
  });

  it("沒有東西要寫就一次呼叫都不發", async () => {
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await client.updateCells([]);

    expect(recorded.batchUpdateCalls).toEqual([]);
    expect(recorded.getSpreadsheetCalls).toEqual([]);
  });

  it("分頁 id 查一次就記住", async () => {
    // UpdateCellsRequest 只認數字 sheetId，不認分頁標題。id 建立之後不會變，
    // 每一輪都重查等於每 20 秒多燒一次配額（spec §7）。
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);
    const write = { tab: "Transactions", rowIndex: 2, cells: [{ kind: "empty" as const }] };

    await client.updateCells([write]);
    await client.updateCells([write]);

    expect(recorded.getSpreadsheetCalls).toEqual([
      { spreadsheetId: SPREADSHEET, fields: "sheets.properties(sheetId,title)" },
    ]);
  });

  it("分頁不存在就拋錯，而且不提試算表 id", async () => {
    const recorded = recordedApi({ tabs: { Transactions: 11 } });
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await expect(
      client.updateCells([
        { tab: "Allocations", rowIndex: 2, cells: [{ kind: "string", value: "a" }] },
      ]),
    ).rejects.toThrow("no such tab: Allocations");
    await expect(
      client.updateCells([
        { tab: "Allocations", rowIndex: 2, cells: [{ kind: "string", value: "a" }] },
      ]),
    ).rejects.not.toThrow(SPREADSHEET);
  });

  it("拒絕 0 或負的列號", async () => {
    const recorded = recordedApi();
    const client = createSheetsClientForApi(recorded.api, SPREADSHEET);

    await expect(client.updateCells([{ tab: "Transactions", rowIndex: 0, cells }])).rejects.toThrow(
      /1-based/,
    );
    expect(recorded.batchUpdateCalls).toEqual([]);
  });
});

describe("createGoogleSheetsClient", () => {
  it("一定包著 withHeaderRows：全新分頁的第一次 updateCells 前會先讀三張分頁的既有內容", async () => {
    // I-1：review 發現把這個 factory 的回傳值換成裸 client（不包 withHeaderRows）
    // 一樣能讓全部測試綠燈——因為唯一驗證 withHeaderRows 行為的測試，測的是
    // 測試自己包出來的 client，不是這個 factory 真正組出來的那個。這裡用
    // `requests` 接縫繞過 GoogleAuth／網路，直接呼叫正式工廠本身：withHeaderRows
    // 在真正寫入前一定會先讀三張分頁各自現有的標題列，才知道要不要補；
    // 裸 client 不會有這三次讀取。
    const recorded = recordedApi();
    const client = createGoogleSheetsClient({
      keyFile: "/unused.json",
      spreadsheetId: SPREADSHEET,
      requests: recorded.api,
    });

    await client.updateCells([
      { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "a" }] },
    ]);

    expect(recorded.getValuesCalls).toHaveLength(3);
  });

  it("服務帳號的 OAuth scope 只到這張試算表，不到整個 Drive", () => {
    // M-3：金鑰一旦外洩，scope 就是「只能碰這張試算表」與「能碰整個 Drive」的
    // 差別，值得一條斷言釘住目前的字串。這裡刻意不傳 `requests`，走真正組裝
    // GoogleAuth 的那條路（google.auth.GoogleAuth 已在檔案頂端換成記錄器）。
    createGoogleSheetsClient({ keyFile: "/unused.json", spreadsheetId: SPREADSHEET });

    expect(google.auth.GoogleAuth).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] }),
    );
  });
});
