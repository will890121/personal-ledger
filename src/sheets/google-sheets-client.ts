import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";

import type { SheetCell } from "../domain/sheet-rows.js";
import type { CellWrite, SheetsClient } from "../ports/sheets-client.js";
import { withHeaderRows } from "./sheet-headers.js";

/**
 * 全專案唯一允許 import `googleapis` 的檔案（見 AC 邊界）。domain／application／
 * ports 碰不到它，`src/sheets/` 的其他檔案也不行——失敗分類（sheet-failure.ts）
 * 是刻意用鴨子定型讀狀態碼，就是為了不在那裡開第二個入口。
 *
 * 這裡只做「型別明確的格子」與「未格式化的讀取」兩件真正重要的事，其餘都是轉接。
 */

/** 服務帳號只需要試算表權限，不要整個 Drive。 */
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/**
 * 每一格都明確給型別，絕不讓 Sheets 自己猜。
 *
 * 這就是為什麼不用 `valueInputOption: "USER_ENTERED"`（spec §4）：使用者的備註
 * 只要以 `=`、`+`、`-`、`@` 開頭，USER_ENTERED 就會把它變成使用者試算表裡一條
 * 活的公式。明確給 `stringValue` 讓公式注入在結構上不可能發生，而不是變成一件
 * 要記得去消毒的事——消毒清單會漏，型別不會。
 */
const CELL_FIELDS = "userEnteredValue,userEnteredFormat.numberFormat";

// 用 googleapis 自己的 schema 型別，不自己抄一份：抄的那一份不會發現
// `userEnterdValue` 這種拼錯——而拼錯的欄位會被 API 靜默忽略。
function toCellData(cell: SheetCell): sheets_v4.Schema$CellData {
  switch (cell.kind) {
    case "string":
      return { userEnteredValue: { stringValue: cell.value } };
    case "number":
      return { userEnteredValue: { numberValue: cell.value } };
    case "date":
      // 序列值加上 DATE 數字格式：值是數字（使用者才能排序、篩選、算月份），
      // 顯示出來才是日期。少了 numberFormat，使用者看到的會是 46295。
      return {
        userEnteredValue: { numberValue: cell.value },
        userEnteredFormat: { numberFormat: { type: "DATE" } },
      };
    case "empty":
      // 空物件配上 CELL_FIELDS 這個遮罩＝把值與數字格式都清掉。清空而不是刪除
      // 列（列號會位移），而且要順手清掉可能殘留的 DATE 格式。
      return {};
  }
}

/** 1 → "A"、2 → "B"、27 → "AA"。`readColumns` 的 range 需要它。 */
export function columnLetter(columnCount: number): string {
  if (!Number.isInteger(columnCount) || columnCount < 1) {
    throw new Error(`column count must be a positive integer: ${String(columnCount)}`);
  }
  let remaining = columnCount;
  let letters = "";
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + index) + letters;
    remaining = (remaining - index - 1) / 26;
  }
  return letters;
}

/** 讀回來的格子一律轉成字串；`null`／缺格是空字串（見 ports 的契約）。 */
function readCell(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * `sheets_v4.Sheets` 上真正用到的三個呼叫，收窄成三個函式。
 *
 * 收窄的理由跟 ports/sheets-client.ts 一樣，但多一條：測試要能逐字斷言送出去的
 * 參數物件（`valueRenderOption` 有沒有帶、有沒有人偷偷用 valueInputOption），
 * 所以接縫必須切在「原始請求參數」這一層，而不是切在某個已經包過一層的介面上。
 */
export interface SheetsApiRequests {
  readonly getSpreadsheet: (params: { spreadsheetId: string; fields: string }) => Promise<{
    data: {
      sheets?:
        | readonly {
            properties?: { sheetId?: number | null; title?: string | null } | null;
          }[]
        | null;
    };
  }>;
  readonly getValues: (params: {
    spreadsheetId: string;
    range: string;
    majorDimension: string;
    valueRenderOption: string;
  }) => Promise<{ data: { values?: readonly unknown[][] | null } }>;
  readonly batchUpdate: (params: {
    spreadsheetId: string;
    requestBody: { requests: sheets_v4.Schema$Request[] };
  }) => Promise<unknown>;
}

/**
 * 真正的實作，接在一組「原始請求」之上。正式環境的組裝走
 * `createGoogleSheetsClient`；測試把一組假的請求函式塞進來，就能驗證送出去的
 * 參數，而不需要憑證或網路。
 */
export function createSheetsClientForApi(
  api: SheetsApiRequests,
  spreadsheetId: string,
): SheetsClient {
  // 分頁標題 → sheetId。`UpdateCellsRequest` 的 GridRange 只認數字 id，不認標題。
  // 一張分頁的 id 建立之後就不會變，所以查到就快取；查不到才重讀一次（使用者
  // 可能剛剛才把分頁建起來），還是查不到就是真的沒有這張分頁。
  const sheetIds = new Map<string, number>();

  async function loadSheetIds(): Promise<void> {
    const response = await api.getSpreadsheet({
      spreadsheetId,
      // 只要 id 與標題。不取整份試算表的內容——那是好幾 MB 的資料與一筆昂貴的呼叫。
      fields: "sheets.properties(sheetId,title)",
    });
    sheetIds.clear();
    for (const sheet of response.data.sheets ?? []) {
      const { sheetId, title } = sheet.properties ?? {};
      if (typeof sheetId === "number" && typeof title === "string") sheetIds.set(title, sheetId);
    }
  }

  async function sheetIdOf(tab: string): Promise<number> {
    const cached = sheetIds.get(tab);
    if (cached !== undefined) return cached;
    await loadSheetIds();
    const loaded = sheetIds.get(tab);
    // 訊息只提分頁名稱（是我們自己的常數），不提試算表 id：Google 的錯誤訊息
    // 會夾帶 id，我們自己丟的錯誤沒有理由跟著夾帶。
    if (loaded === undefined) throw new Error(`no such tab: ${tab}`);
    return loaded;
  }

  return {
    readColumns: async (tab, columnCount) => {
      const response = await api.getValues({
        spreadsheetId,
        range: `${tab}!A:${columnLetter(columnCount)}`,
        majorDimension: "ROWS",
        // 非得明寫不可。預設的 FORMATTED_VALUE 會把日期欄回成 "2026/9/28"，
        // 引擎 `Number()` 之後是 NaN、舊月份被靜默丟掉，而測試依然全綠。
        // 見 ports/sheets-client.ts 對這一條的完整說明。
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      // 尾端全空的列與格子 Google 會直接省略，所以每一列都要補到 columnCount。
      return (response.data.values ?? []).map((row) =>
        Array.from({ length: columnCount }, (_, index) => readCell(row[index])),
      );
    },

    updateCells: async (writes: readonly CellWrite[]) => {
      // 沒有東西要寫就一次呼叫都不發：配額是有限的（spec §7）。
      if (writes.length === 0) return;
      const requests: sheets_v4.Schema$Request[] = [];
      for (const write of writes) {
        if (write.rowIndex < 1) throw new Error("row index must be 1-based");
        if (write.cells.length === 0) throw new Error(`empty cell list for ${write.tab}`);
        requests.push({
          updateCells: {
            range: {
              sheetId: await sheetIdOf(write.tab),
              // GridRange 是 0-based、結束值不含；CellWrite.rowIndex 是 1-based。
              startRowIndex: write.rowIndex - 1,
              endRowIndex: write.rowIndex,
              startColumnIndex: 0,
              endColumnIndex: write.cells.length,
            },
            rows: [{ values: write.cells.map(toCellData) }],
            fields: CELL_FIELDS,
          },
        });
      }
      // 一次 batchUpdate＝一筆原子請求，這就是 ports 契約要的「全有全無」：
      // 拆成多次呼叫會讓失敗停在半套用的狀態上，下一輪重做時面對的是髒資料。
      await api.batchUpdate({ spreadsheetId, requestBody: { requests } });
    },
  };
}

export interface GoogleSheetsClientOptions {
  /** 服務帳號金鑰檔的路徑（`GOOGLE_SERVICE_ACCOUNT_KEY_FILE`）。 */
  readonly keyFile: string;
  readonly spreadsheetId: string;
}

/**
 * 正式環境的組裝。金鑰檔在這裡只交給 GoogleAuth，不自己讀、不自己解析，
 * 也不記進任何日誌——logger 的拒絕清單另外擋了 privateKey／client_email，
 * 兩道防線都要有。
 *
 * 一定經過 `withHeaderRows`：唯一一條取得正式 client 的路徑都會補標題列，
 * 這樣「忘記接標題列」就不是一個做得到的錯誤。
 */
export function createGoogleSheetsClient(options: GoogleSheetsClientOptions): SheetsClient {
  const auth = new google.auth.GoogleAuth({ keyFile: options.keyFile, scopes: SCOPES });
  const api = google.sheets({ version: "v4", auth });
  return withHeaderRows(
    createSheetsClientForApi(
      {
        getSpreadsheet: (params) => api.spreadsheets.get(params),
        getValues: (params) => api.spreadsheets.values.get(params),
        batchUpdate: (params) => api.spreadsheets.batchUpdate(params),
      },
      options.spreadsheetId,
    ),
  );
}
