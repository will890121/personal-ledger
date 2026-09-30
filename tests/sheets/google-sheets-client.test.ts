import { describe, expect, it } from "vitest";

import type { SheetCell } from "../../src/domain/sheet-rows.js";
import {
  columnLetter,
  createSheetsClientForApi,
  type SheetsApiRequests,
} from "../../src/sheets/google-sheets-client.js";

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
