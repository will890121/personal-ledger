import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";
import { SqliteSummaryRepository } from "../../src/db/sqlite-summary-repository.js";
import type { SheetCell } from "../../src/domain/sheet-rows.js";
import {
  ALLOCATIONS_HEADER,
  MONTHLY_SUMMARY_HEADER,
  TRANSACTIONS_HEADER,
  allocationRows,
  transactionRow,
} from "../../src/domain/sheet-rows.js";
import { toSheetSerialDate } from "../../src/domain/sheet-serial-date.js";
import type { CellWrite, SheetsClient } from "../../src/ports/sheets-client.js";
import {
  createGoogleSheetsApiRequests,
  createGoogleSheetsClient,
  createSheetsClientForApi,
} from "../../src/sheets/google-sheets-client.js";
import { withHeaderRows } from "../../src/sheets/sheet-headers.js";
import {
  ALLOCATIONS_TAB,
  MONTHLY_SUMMARY_TAB,
  TRANSACTIONS_TAB,
  createSheetMirror,
} from "../../src/sheets/sheet-mirror.js";
import { seedTransaction } from "../fixtures/sheet-sync-seed.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

/**
 * 唯一會去打真實 Google Sheets API 的測試。`pnpm test:sheets` 才會跑到它，
 * `pnpm check` 明確排除（見 vitest.config.ts 的 exclude 與 vitest.integration.config.ts）。
 *
 * 為什麼一定要有這一組：**替身證明不了我們對 Sheets 語意的理解是對的。** M4 最貴的一課是
 * `scripts/backup.sh` 壞了整整一個里程碑、510 條測試全綠，唯一發現它的原因是有人真的
 * 跑了一次。所以這裡的每一條斷言都從真實 Sheet 讀回來比對，一條都不看記憶體狀態——
 * 看記憶體狀態就只是再測一次我們自己的模型，而模型正是被懷疑的那一方。
 */

const KEY_FILE_VARIABLE = "GOOGLE_SERVICE_ACCOUNT_KEY_FILE";
const TEST_SPREADSHEET_VARIABLE = "SHEETS_TEST_SPREADSHEET_ID";
const PRODUCTION_SPREADSHEET_VARIABLE = "SHEET_SPREADSHEET_ID";

/**
 * 缺憑證時**大聲失敗**，不是跳過。
 *
 * 無聲跳過的整合測試是另一種空轉的守衛：它報告成功，而它什麼都沒測。這個 throw 發生在
 * 模組載入（collect）階段，所以 vitest 會把整個檔案標成失敗、指令以非零離開碼結束，
 * 而缺哪一個變數會逐字印出來。
 *
 * 另外拒絕指向正式試算表：這組測試會清空並重寫三張分頁。指向使用者真正在看的那張表，
 * 就不是測試失敗而是資料消失——而且沒有任何辦法還原。這道檢查比錯誤訊息重要。
 */
function requireIntegrationEnvironment(): { keyFile: string; spreadsheetId: string } {
  const keyFile = process.env[KEY_FILE_VARIABLE]?.trim();
  const spreadsheetId = process.env[TEST_SPREADSHEET_VARIABLE]?.trim();

  const missing: string[] = [];
  if (keyFile === undefined || keyFile === "") missing.push(KEY_FILE_VARIABLE);
  if (spreadsheetId === undefined || spreadsheetId === "") missing.push(TEST_SPREADSHEET_VARIABLE);
  if (
    keyFile === undefined ||
    keyFile === "" ||
    spreadsheetId === undefined ||
    spreadsheetId === ""
  )
    throw new Error(
      `pnpm test:sheets 缺少環境變數：${missing.join("、")}。\n` +
        `${KEY_FILE_VARIABLE} 是服務帳號 JSON 金鑰檔的路徑；` +
        `${TEST_SPREADSHEET_VARIABLE} 是一張「拋棄式」試算表的 id，` +
        `裡面必須先有 ${TRANSACTIONS_TAB}／${ALLOCATIONS_TAB}／${MONTHLY_SUMMARY_TAB} 三張分頁，` +
        `並已分享給服務帳號的 email（編輯權限）。\n` +
        `這組測試會清空並重寫那三張分頁，所以絕不可以用正式的 ${PRODUCTION_SPREADSHEET_VARIABLE}。\n` +
        `無聲跳過的整合測試就是另一種空轉的守衛（它會報告成功，而它什麼都沒測），所以這裡直接失敗。`,
    );

  const production = process.env[PRODUCTION_SPREADSHEET_VARIABLE]?.trim();
  if (production !== undefined && production !== "" && production === spreadsheetId) {
    throw new Error(
      `${TEST_SPREADSHEET_VARIABLE} 與 ${PRODUCTION_SPREADSHEET_VARIABLE} 是同一張試算表，拒絕執行。\n` +
        `這組測試會清空並重寫三張分頁；指向正式試算表不是測試失敗，是使用者的資料消失。` +
        `請另外開一張拋棄式試算表，並把它的 id 放進 ${TEST_SPREADSHEET_VARIABLE}。`,
    );
  }

  return { keyFile, spreadsheetId };
}

const { keyFile, spreadsheetId } = requireIntegrationEnvironment();

/**
 * `requireIntegrationEnvironment` 只在「兩個變數的值相等」時拒絕執行。沒被拒絕
 * **不代表已經確認安全**——也可能是因為 `SHEET_SPREADSHEET_ID` 根本沒進到這個
 * 行程裡（忘了先 `set -a; . ./.env; set +a` 就把值帶進 shell，或這台機器本來就
 * 沒有設定正式試算表）。這兩種情況都要在 `clearWorkbook()` 真正動手之前大聲說
 * 出來，而不是靜默通過——「我無法確認這不是你的正式試算表」比靜默安全得多。
 */
const productionSpreadsheetId = process.env[PRODUCTION_SPREADSHEET_VARIABLE]?.trim();

/**
 * 未經任何裝飾包過的真實 client。
 *
 * 清空分頁、擺放「使用者手動改壞」的內容、以及讀回來比對，全部走這一條——它們不該
 * 順手觸發 `withHeaderRows` 的標題列檢查，否則量到的是兩層行為的疊加。
 * 鏡像本身走的是正式組裝入口 `createGoogleSheetsClient`（見下方 `runScenario`）。
 */
const rawSheets: SheetsClient = createSheetsClientForApi(
  createGoogleSheetsApiRequests(keyFile),
  spreadsheetId,
);

const TAB_WIDTHS: readonly (readonly [string, number])[] = [
  [TRANSACTIONS_TAB, TRANSACTIONS_HEADER.length],
  [ALLOCATIONS_TAB, ALLOCATIONS_HEADER.length],
  [MONTHLY_SUMMARY_TAB, MONTHLY_SUMMARY_HEADER.length],
];

const blankCells = (width: number): SheetCell[] =>
  Array.from({ length: width }, (): SheetCell => ({ kind: "empty" }));

/** 一整列原始字串轉回具型別的格子：空字串＝清空，其餘一律當成**字串**。 */
const rawCells = (values: readonly string[]): SheetCell[] =>
  values.map((value): SheetCell => (value === "" ? { kind: "empty" } : { kind: "string", value }));

const rawRow = (key: string, width: number): string[] => {
  const row = Array.from({ length: width }, () => "");
  row[0] = key;
  return row;
};

interface Workbook {
  readonly transactions: string[][];
  readonly allocations: string[][];
  readonly months: string[][];
}

async function readWorkbook(client: SheetsClient): Promise<Workbook> {
  return {
    transactions: await client.readColumns(TRANSACTIONS_TAB, TRANSACTIONS_HEADER.length),
    allocations: await client.readColumns(ALLOCATIONS_TAB, ALLOCATIONS_HEADER.length),
    months: await client.readColumns(MONTHLY_SUMMARY_TAB, MONTHLY_SUMMARY_HEADER.length),
  };
}

/**
 * 把三張分頁上目前有內容的每一列整列清空。
 *
 * 清空而不是刪除列：`SheetsClient` 這個窄介面刻意沒有刪除列的能力（刪除會讓列號位移，
 * 而列號位移正是 Review Focus #3 要防的事），所以這裡也只能清空——這剛好也是鏡像
 * 自己清殭屍列的做法，順便驗證那個做法在真實 API 上真的可行。
 *
 * 分頁不存在時給出可行動的錯誤訊息：Google 回的是一句 `Unable to parse range`，
 * 而真正該做的事是「去那張試算表上把分頁建出來」。
 */
async function clearWorkbook(): Promise<void> {
  // 在真正動手之前，先印出它即將清空的試算表 id——這是真正會清資料的一步，
  // 不能無聲無息地就做下去。
  console.error(
    `[test:sheets] 即將清空試算表 ${spreadsheetId} 的 ${TRANSACTIONS_TAB}／` +
      `${ALLOCATIONS_TAB}／${MONTHLY_SUMMARY_TAB} 三張分頁 —— 每一列目前有內容的都會被整列清空。`,
  );
  if (productionSpreadsheetId === undefined || productionSpreadsheetId === "") {
    // 不因為未設就拒絕執行：一台沒有正式設定的機器應該仍然可以跑這組測試。
    // 但既然沒有東西可以比對，就必須大聲說出「無法確認」，而不是假裝已經查過。
    console.error(
      `[test:sheets] ${PRODUCTION_SPREADSHEET_VARIABLE} 未設定，我無法確認 ${spreadsheetId} ` +
        `不是你的正式試算表。如果這是正式試算表，現在就按 Ctrl+C 中止，改用一張拋棄式 ` +
        `試算表的 id 填進 ${TEST_SPREADSHEET_VARIABLE}。`,
    );
  }
  const writes: CellWrite[] = [];
  for (const [tab, width] of TAB_WIDTHS) {
    let rows: string[][];
    try {
      rows = await rawSheets.readColumns(tab, width);
    } catch (error) {
      throw new Error(
        `讀不到分頁「${tab}」。${TEST_SPREADSHEET_VARIABLE} 指向的試算表必須先有 ` +
          `${TRANSACTIONS_TAB}／${ALLOCATIONS_TAB}／${MONTHLY_SUMMARY_TAB} 三張分頁，` +
          `且已分享給服務帳號的 email（編輯權限）。`,
        { cause: error },
      );
    }
    for (let i = 0; i < rows.length; i += 1) {
      writes.push({ tab, rowIndex: i + 1, cells: blankCells(width) });
    }
  }
  if (writes.length > 0) await rawSheets.updateCells(writes);
}

// ---------------------------------------------------------------------------
// 測試帳本
// ---------------------------------------------------------------------------

const OWNER = "owner-1";
/** 固定時鐘：摘要分頁的「更新時間」欄會寫進這個值，替身與真實兩邊才比得起來。 */
const NOW = new Date("2026-10-08T05:00:00.000Z");

/** id 一律做成 UUID 形狀：清殭屍列的判準就是「UUID 形狀 + SQLite 裡找不到」。 */
const uuid = (label: string): string => `00000000-0000-4000-8000-${label.padStart(12, "0")}`;

const T1 = uuid("1");
const T2 = uuid("2");
const T3 = uuid("3");
const A1 = uuid("a1");
const A1B = uuid("a1b");
const A2 = uuid("a2");
const A3 = uuid("a3");
const GHOST = uuid("dead");
const HAND_TYPED = "我自己的備註";

/**
 * 以 `=` 開頭的備註。`USER_ENTERED` 會把它變成使用者試算表裡一條活的公式；
 * 明確給 `stringValue` 讓它留在字面上（spec §4、Review Focus #2）。
 * 真實 API 才有這個分岔——替身裡任何字串都只是字串，所以這一條只有這裡測得到。
 */
const FORMULA_NOTE = "=SUM(A1:A9)";

interface Ledger {
  readonly database: Database.Database;
  readonly syncRepository: SqliteSheetSyncRepository;
  readonly summaryRepository: SqliteSummaryRepository;
}

function openLedger(): Ledger {
  const database = new Database(":memory:");
  migrate(database);
  // 全新資料庫上 categories 是空的（migration 0002 只搬既有交易），配置的外鍵需要它。
  database
    .prepare(
      `INSERT INTO categories (category_id, owner_id, key, name, kind, depth, active)
       VALUES ('cat-1', ?, 'expense_dining', '餐飲', 'expense', 1, 1)`,
    )
    .run(OWNER);
  return {
    database,
    syncRepository: new SqliteSheetSyncRepository(database),
    summaryRepository: new SqliteSummaryRepository(database),
  };
}

function addAllocation(
  database: Database.Database,
  input: { allocationId: string; transactionId: string; amount: string },
): void {
  database
    .prepare(
      `INSERT INTO allocations (
         allocation_id, transaction_id, funds_effect, purpose, amount, currency,
         category_id, category_snapshot, subcategory_snapshot
       ) VALUES (?, ?, 'outflow', 'expense', ?, 'TWD', 'cat-1', '餐飲', '午餐')`,
    )
    .run(input.allocationId, input.transactionId, input.amount);
}

/** 改一筆交易，順便推進 updated_at——否則增量同步看不到這次變更。 */
function touch(
  database: Database.Database,
  transactionId: string,
  changes: { updatedAt: string; occurredDate?: string; amount?: string; status?: string },
): void {
  const row = database
    .prepare("SELECT occurred_date, amount, status FROM transactions WHERE transaction_id = ?")
    .get(transactionId) as { occurred_date: string; amount: string; status: string };
  database
    .prepare(
      `UPDATE transactions SET occurred_date = ?, amount = ?, status = ?, updated_at = ?
       WHERE transaction_id = ?`,
    )
    .run(
      changes.occurredDate ?? row.occurred_date,
      changes.amount ?? row.amount,
      changes.status ?? row.status,
      changes.updatedAt,
      transactionId,
    );
}

type ScenarioStep = "created" | "edited" | "moved" | "deleted" | "corrupted" | "reconciled";

/**
 * 一整串「使用者真的會做的事」，餵給任何一個 `SheetsClient`。
 *
 * 真實 adapter 與 `FakeSheetsClient` 跑的是**同一個函式**（差分測試的前提就是這個）：
 * 序列若各抄一份，兩邊遲早會在某一步上不一樣，而那時差分測試比的就不是語意差異，
 * 是抄錯。`onStep` 讓呼叫端在每一步結束後從對應的 Sheet 讀回快照。
 */
async function runScenario(parts: {
  readonly sheets: SheetsClient;
  readonly raw: SheetsClient;
  readonly ledger: Ledger;
  readonly onStep?: (step: ScenarioStep) => Promise<void>;
}): Promise<void> {
  const { sheets, raw, ledger } = parts;
  const { database } = ledger;
  const mirror = createSheetMirror({
    ownerId: OWNER,
    sheets,
    syncRepository: ledger.syncRepository,
    summaryRepository: ledger.summaryRepository,
    now: () => NOW,
  });
  const step = async (name: ScenarioStep): Promise<void> => {
    if (parts.onStep !== undefined) await parts.onStep(name);
  };

  // 1. 建立三筆交易，其中 T2 落在九月（之後要跨月搬移），T1 帶一則以 = 開頭的備註。
  seedTransaction(database, OWNER, {
    id: T1,
    updatedAt: "2026-10-05T00:00:01.000Z",
    occurredDate: "2026-10-02",
    amount: "100",
  });
  database
    .prepare("UPDATE transactions SET note = ? WHERE transaction_id = ?")
    .run(FORMULA_NOTE, T1);
  addAllocation(database, { allocationId: A1, transactionId: T1, amount: "100" });
  seedTransaction(database, OWNER, {
    id: T2,
    updatedAt: "2026-10-05T00:00:02.000Z",
    occurredDate: "2026-09-20",
    amount: "200",
  });
  addAllocation(database, { allocationId: A2, transactionId: T2, amount: "200" });
  seedTransaction(database, OWNER, {
    id: T3,
    updatedAt: "2026-10-05T00:00:03.000Z",
    occurredDate: "2026-10-04",
    amount: "300",
  });
  addAllocation(database, { allocationId: A3, transactionId: T3, amount: "300" });
  expect((await mirror.syncOnce()).kind).toBe("synced");
  await step("created");

  // 2. 改 T1：updateTransaction 是「DELETE 全部配置再 INSERT」，所以 A1 消失、A1B 出現。
  database.prepare("DELETE FROM allocations WHERE transaction_id = ?").run(T1);
  addAllocation(database, { allocationId: A1B, transactionId: T1, amount: "150" });
  touch(database, T1, { updatedAt: "2026-10-06T00:00:01.000Z", amount: "150" });
  expect((await mirror.syncOnce()).kind).toBe("synced");
  await step("edited");

  // 3. 跨月搬移 T2：九月與十月兩張摘要列都要被重算。舊月份只能從 Sheet 上的舊日期
  //    （未格式化的序列值）算出來——這一步是 `valueRenderOption` 契約的實戰驗證。
  touch(database, T2, { updatedAt: "2026-10-06T00:00:02.000Z", occurredDate: "2026-10-20" });
  expect((await mirror.syncOnce()).kind).toBe("synced");
  await step("moved");

  // 4. 軟刪除 T3：交易列留著，狀態欄改成 deleted。
  touch(database, T3, { updatedAt: "2026-10-06T00:00:03.000Z", status: "deleted" });
  expect((await mirror.syncOnce()).kind).toBe("synced");
  await step("deleted");

  // 5. 手動把 Sheet 改亂：改掉 T1 的金額、附加一列鏡像留下的殭屍列、附加一列使用者
  //    手打的內容。三種都是真實會發生的事，而且後兩者的處置必須不同。
  const transactions = await raw.readColumns(TRANSACTIONS_TAB, TRANSACTIONS_HEADER.length);
  const t1Index = transactions.findIndex((row) => row[0] === T1);
  expect(t1Index).toBeGreaterThan(0);
  const t1Row = [...(transactions[t1Index] as string[])];
  t1Row[3] = "999999";
  const appendAt = transactions.length + 1;
  await raw.updateCells([
    { tab: TRANSACTIONS_TAB, rowIndex: t1Index + 1, cells: rawCells(t1Row) },
    {
      tab: TRANSACTIONS_TAB,
      rowIndex: appendAt,
      cells: rawCells(rawRow(GHOST, TRANSACTIONS_HEADER.length)),
    },
    {
      tab: TRANSACTIONS_TAB,
      rowIndex: appendAt + 1,
      cells: rawCells(rawRow(HAND_TYPED, TRANSACTIONS_HEADER.length)),
    },
  ]);
  await step("corrupted");

  // 6. 校正：收斂回 SQLite 的投影，清掉殭屍列，一格都不動使用者手打的列。
  const outcome = await mirror.reconcile();
  expect(outcome).toEqual({ kind: "synced", transactions: 3, months: 1, scannedToEnd: true });
  await step("reconciled");
}

// ---------------------------------------------------------------------------
// 比對工具
// ---------------------------------------------------------------------------

const renderCell = (cell: SheetCell): string => {
  switch (cell.kind) {
    case "string":
      return cell.value;
    case "number":
    case "date":
      return String(cell.value);
    case "empty":
      return "";
  }
};

const MIRROR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mirrorRows = (rows: readonly string[][]): string[][] =>
  rows.slice(1).filter((row) => MIRROR_ID.test(row[0] ?? ""));

const dataRows = (rows: readonly string[][]): string[][] =>
  rows.slice(1).filter((row) => row.some((cell) => cell !== ""));

const sorted = (rows: readonly string[][]): string[][] =>
  [...rows]
    .map((row) => [...row])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/**
 * 去掉尾端全空的列。
 *
 * 這是真實 API 與替身唯一被允許的差異，而且它本身就是一條被釘住的斷言（見下方
 * 「讀回來的列尾」那一條探針）：Google 的 `values.get` 完全省略尾端全空的列，
 * 替身則把清空過的列原樣留著。比對整份工作表時先把這個差異正規化掉，其餘每一格
 * 都必須逐字相同——若哪天連這個都不夠，那就是真的漂移了，而不是尾端空列。
 */
const withoutTrailingEmptyRows = (rows: readonly string[][]): string[][] => {
  let end = rows.length;
  while (end > 0 && (rows[end - 1] ?? []).every((cell) => cell === "")) end -= 1;
  return rows.slice(0, end).map((row) => [...row]);
};

const normalized = (workbook: Workbook): Workbook => ({
  transactions: withoutTrailingEmptyRows(workbook.transactions),
  allocations: withoutTrailingEmptyRows(workbook.allocations),
  months: withoutTrailingEmptyRows(workbook.months),
});

/** 直接從 SQLite 算出「應該出現在 Sheet 上的列」，不經過任何 Sheet 狀態。 */
async function expectedProjection(
  ledger: Ledger,
): Promise<{ transactions: string[][]; allocations: string[][] }> {
  const all = await ledger.syncRepository.listChangedTransactions(OWNER, null, 10_000);
  return {
    transactions: all.map((txn) => transactionRow(txn).map(renderCell)),
    allocations: all.flatMap((txn) => allocationRows(txn).map((row) => row.map(renderCell))),
  };
}

// ---------------------------------------------------------------------------
// 真實來回
// ---------------------------------------------------------------------------

describe("真實 Google Sheets 來回", () => {
  /** 每一步結束後從**真實 Sheet** 讀回來的快照。所有斷言都只看這些，不看記憶體狀態。 */
  const snapshots = new Map<ScenarioStep, Workbook>();
  const ledger = openLedger();

  const at = (step: ScenarioStep): Workbook => {
    const workbook = snapshots.get(step);
    if (workbook === undefined) throw new Error(`no snapshot for step ${step}`);
    return workbook;
  };

  beforeAll(async () => {
    await clearWorkbook();
    // 鏡像走的是正式組裝入口：真的建立 GoogleAuth、真的包上 withHeaderRows。
    // 這一行本身就是驗證的一部分——正式環境若連不上或 scope 不對，這裡就會炸。
    await runScenario({
      sheets: createGoogleSheetsClient({ keyFile, spreadsheetId }),
      raw: rawSheets,
      ledger,
      onStep: async (step) => {
        snapshots.set(step, await readWorkbook(rawSheets));
      },
    });
  });

  afterAll(() => {
    ledger.database.close();
  });

  it("第一次有資料的寫入會補上三張分頁的標題列", () => {
    const workbook = at("created");
    expect(workbook.transactions[0]).toEqual([...TRANSACTIONS_HEADER]);
    expect(workbook.allocations[0]).toEqual([...ALLOCATIONS_HEADER]);
    expect(workbook.months[0]).toEqual([...MONTHLY_SUMMARY_HEADER]);
  });

  it("建列之後，三筆交易與三筆配置都真的在 Sheet 上", () => {
    // 這一條只比「哪些列存在」。逐格的值（日期型別、金額型別、= 開頭的備註）由下面
    // 幾條針對性的斷言負責，收斂到投影則由最後的校正那一條負責——那一刻 SQLite
    // 與 Sheet 才應該完全相等。
    const workbook = at("created");
    expect([...mirrorRows(workbook.transactions).map((row) => row[0])].sort()).toEqual(
      [T1, T2, T3].sort(),
    );
    expect([...mirrorRows(workbook.allocations).map((row) => row[0])].sort()).toEqual(
      [A1, A2, A3].sort(),
    );
  });

  it("以 = 開頭的備註讀回來還是字面字串，不是公式", () => {
    // 這一條只有真實 API 測得到：替身裡任何字串都只是字串。若哪天有人把
    // valueInputOption 改成 USER_ENTERED，備註會變成使用者試算表裡一條活的公式，
    // 而 UNFORMATTED_VALUE 讀回來的會是公式的計算結果（0 或 #ERROR!），不是原文。
    const row = mirrorRows(at("created").transactions).find((cells) => cells[0] === T1);
    expect(row?.[8]).toBe(FORMULA_NOTE);
  });

  it("日期欄讀回來是未格式化的序列值，不是顯示用的日期字串", () => {
    // ports/sheets-client.ts 的契約。少了 valueRenderOption: UNFORMATTED_VALUE，
    // 這裡會讀到 "2026/10/2"，引擎 Number() 之後是 NaN、跨月搬移的舊月份被靜默丟棄，
    // 而所有單元測試依然全綠（替身存的就是序列值）。
    const row = mirrorRows(at("created").transactions).find((cells) => cells[0] === T1);
    expect(row?.[1]).toBe(String(toSheetSerialDate("2026-10-02")));
    // 金額也必須是數字而不是文字，否則使用者在 Sheet 上 SUM 出來會是 0。
    expect(row?.[3]).toBe("100");
  });

  it("改交易會換掉配置列，舊的 allocation_id 不留在 Sheet 上", () => {
    const allocations = mirrorRows(at("edited").allocations).map((row) => row[0]);
    expect([...allocations].sort()).toEqual([A1B, A2, A3].sort());
    expect(allocations).not.toContain(A1);
  });

  it("跨月搬移會同時重算舊月份與新月份", () => {
    // 九月的摘要必須被重算（T2 搬走了），十月的也必須（T2 搬進來了）。
    // 這是 Review Focus #1，而它成立的前提是上面那條「日期欄是序列值」。
    const months = dataRows(at("moved").months).map((row) => row[0]);
    expect(months).toContain("2026-09");
    expect(months).toContain("2026-10");
    const september = dataRows(at("moved").months).find((row) => row[0] === "2026-09");
    // T2 搬走之後九月就沒有任何交易了，實際流出必須回到 0。
    expect(september?.[2]).toBe("0");
  });

  it("軟刪除保留交易列，只把狀態欄改成 deleted", () => {
    const row = mirrorRows(at("deleted").transactions).find((cells) => cells[0] === T3);
    expect(row?.[10]).toBe("deleted");
  });

  it("手動改壞之後，校正讓 Sheet 收斂回 SQLite 的投影", async () => {
    const expected = await expectedProjection(ledger);
    const workbook = at("reconciled");
    expect(sorted(mirrorRows(workbook.transactions))).toEqual(sorted(expected.transactions));
    expect(sorted(mirrorRows(workbook.allocations))).toEqual(sorted(expected.allocations));
    // 被改成 999999 的那一格要被寫回正確值。
    const restored = mirrorRows(workbook.transactions).find((row) => row[0] === T1);
    expect(restored?.[3]).toBe("150");
  });

  it("校正清掉鏡像的殭屍列，但一格都不動使用者手打的列", () => {
    const keys = at("reconciled").transactions.map((row) => row[0]);
    // 鏡像自己留下、來源已經不存在的列：清掉。
    expect(keys).not.toContain(GHOST);
    // 使用者手打的列：留著。每天半夜靜靜地把它清掉，比它要修的殭屍列嚴重得多。
    expect(keys).toContain(HAND_TYPED);
  });

  it("同一串操作，替身與真實 adapter 讀回來的內容逐格相同", async () => {
    // 差分測試（spec §9）。替身一旦與真實行為漂移，所有用替身寫的單元測試就同時
    // 失去意義——而且不會有任何一條變紅。這一條是唯一會變紅的那條。
    //
    // 兩邊各有自己的 SQLite（同步狀態表是共用的，同一個帳本跑第二次只會是 idle），
    // 種的資料、id 與時鐘完全相同，跑的是同一個 runScenario。
    const fakeLedger = openLedger();
    try {
      const fake = new FakeSheetsClient({
        [TRANSACTIONS_TAB]: [],
        [ALLOCATIONS_TAB]: [],
        [MONTHLY_SUMMARY_TAB]: [],
      });
      await runScenario({
        // 與真實那一邊對稱：同一個標題列裝飾包在同一個位置。
        sheets: withHeaderRows(fake),
        raw: fake,
        ledger: fakeLedger,
      });

      const fakeWorkbook = await readWorkbook(fake);
      expect(normalized(fakeWorkbook)).toEqual(normalized(at("reconciled")));
    } finally {
      fakeLedger.database.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 空帳本
// ---------------------------------------------------------------------------

describe("空帳本", () => {
  it("沒有任何交易時一次 API 呼叫都不發，三張分頁保持全空（連標題都還沒有）", async () => {
    // 這條是驗收文件裡那個「使用者會誤讀成故障」的第一項：剛設定好、還沒記過帳，
    // 三張分頁看起來空空如也是**正確**的。標題列只在第一次有資料的寫入時才補上。
    await clearWorkbook();
    const ledger = openLedger();
    try {
      const mirror = createSheetMirror({
        ownerId: OWNER,
        sheets: createGoogleSheetsClient({ keyFile, spreadsheetId }),
        syncRepository: ledger.syncRepository,
        summaryRepository: ledger.summaryRepository,
        now: () => NOW,
      });
      expect(await mirror.syncOnce()).toEqual({ kind: "idle" });
      const workbook = await readWorkbook(rawSheets);
      expect(workbook.transactions).toEqual([]);
      expect(workbook.allocations).toEqual([]);
      expect(workbook.months).toEqual([]);
    } finally {
      ledger.database.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 替身與真實 adapter 的四個已知語意落差
// ---------------------------------------------------------------------------

/**
 * 上面那條逐格比對只證明「引擎**合法**用法下兩邊一致」。這四條探針管的是另一件事：
 * 替身刻意比真實嚴格的四個地方，它們的語意目前只被替身自己的測試定義過
 * （tests/support/fake-sheets-client.test.ts），也就是說「真實 API 到底怎麼做」
 * 從來沒有被任何東西量過——漂移會躲在這四個地方。
 *
 * 每一條都同時釘住兩邊：真實 API 做什麼、替身做什麼。哪一邊改了行為，這裡就變紅。
 */
describe("替身與真實 adapter 的四個已知語意落差", () => {
  const WIDTH = TRANSACTIONS_HEADER.length;
  const filledRow = (mark: string): SheetCell[] =>
    Array.from({ length: WIDTH }, (_, index): SheetCell => ({
      kind: "string",
      value: `${mark}-${String(index + 1)}`,
    }));
  const filledStrings = (mark: string): string[] =>
    Array.from({ length: WIDTH }, (_, index) => `${mark}-${String(index + 1)}`);

  const freshFake = (): FakeSheetsClient => new FakeSheetsClient({ [TRANSACTIONS_TAB]: [] });

  it("落差 1：窄寫入只碰指定範圍，同列其餘欄位不會被清掉（替身拒絕這種寫入）", async () => {
    await clearWorkbook();
    await rawSheets.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 2, cells: filledRow("a") }]);
    await rawSheets.updateCells([
      { tab: TRANSACTIONS_TAB, rowIndex: 2, cells: [{ kind: "string", value: "changed" }] },
    ]);

    const rows = await rawSheets.readColumns(TRANSACTIONS_TAB, WIDTH);
    const expected = filledStrings("a");
    expected[0] = "changed";
    // 真實的 UpdateCellsRequest 只碰 startColumnIndex..endColumnIndex，其餘原封不動。
    expect(rows[1]).toEqual(expected);

    // 替身則直接拒絕：它是「整列取代」的模型，靜默套用會讓「引擎寫錯欄數」這種
    // 錯誤在測試裡完全沒有訊號。這個嚴格度是刻意的，不是漂移——而它之所以安全，
    // 正是因為上面那一半證明了真實 API 在同樣的寫入下行為不同。
    const fake = freshFake();
    await fake.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 1, cells: filledRow("a") }]);
    await expect(
      fake.updateCells([
        { tab: TRANSACTIONS_TAB, rowIndex: 2, cells: [{ kind: "string", value: "changed" }] },
      ]),
    ).rejects.toThrow(/expected 13 cells/);
  });

  it("落差 2：超出標題寬度的寫入真實 API 會接受（替身拒絕）", async () => {
    await clearWorkbook();
    const wide: SheetCell[] = [...filledRow("b"), { kind: "string", value: "extra" }];
    await rawSheets.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 2, cells: wide }]);

    const rows = await rawSheets.readColumns(TRANSACTIONS_TAB, WIDTH + 1);
    expect(rows[1]).toEqual([...filledStrings("b"), "extra"]);

    const fake = freshFake();
    await fake.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 1, cells: filledRow("b") }]);
    await expect(
      fake.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 2, cells: wide }]),
    ).rejects.toThrow(/expected 13 cells/);
  });

  it("落差 3：同一批寫到同一列，真實 API 是後寫獲勝（替身拒絕整批）", async () => {
    await clearWorkbook();
    const first = filledRow("c");
    const second = filledRow("d");
    await rawSheets.updateCells([
      { tab: TRANSACTIONS_TAB, rowIndex: 2, cells: first },
      { tab: TRANSACTIONS_TAB, rowIndex: 2, cells: second },
    ]);

    const rows = await rawSheets.readColumns(TRANSACTIONS_TAB, WIDTH);
    // 一次 batchUpdate 裡的請求依序套用，所以最後一筆的內容留在 Sheet 上，
    // 而「引擎算錯列號」這件事在真實 API 上完全沒有訊號——這就是替身要拒絕它的理由。
    expect(rows[1]).toEqual(filledStrings("d"));

    const fake = freshFake();
    await expect(
      fake.updateCells([
        { tab: TRANSACTIONS_TAB, rowIndex: 2, cells: first },
        { tab: TRANSACTIONS_TAB, rowIndex: 2, cells: second },
      ]),
    ).rejects.toThrow(/duplicate write/);
  });

  it("落差 4：讀回來的列會補到要求的寬度，但尾端全空的列會被整列省略（替身留著）", async () => {
    await clearWorkbook();
    const onlyKey = rawCells(rawRow("e", WIDTH));
    await rawSheets.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 2, cells: onlyKey }]);

    const filled = await rawSheets.readColumns(TRANSACTIONS_TAB, WIDTH);
    // 補寬度：Google 省略一列尾端的空格，adapter 補回到 columnCount（ports 的契約）。
    expect(filled).toHaveLength(2);
    expect(filled[0]).toEqual(Array.from({ length: WIDTH }, () => ""));
    expect(filled[1]).toEqual(rawRow("e", WIDTH));

    // 整列清空之後，這一列在真實 API 眼裡就不存在了：連 `values` 都不會回。
    await rawSheets.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 2, cells: blankCells(WIDTH) }]);
    expect(await rawSheets.readColumns(TRANSACTIONS_TAB, WIDTH)).toEqual([]);

    // 替身把清空過的列原樣留著，所以列數不變。
    //
    // 這個落差對鏡像是無害的，但無害要講得出理由：`locatorOf` 是以 id 為鍵查列號，
    // 讀回來的列數只影響 `nextRow`（新 id 附加的位置）。真實那邊尾端的空列會被
    // 重複利用，替身那邊會一直累積——兩邊都收斂，只是空列多寡不同。真正危險的
    // 反向假設是「列號可以快取」，而那條由 locatorOf 每輪重建擋住。
    const fake = freshFake();
    await fake.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 2, cells: onlyKey }]);
    await fake.updateCells([{ tab: TRANSACTIONS_TAB, rowIndex: 2, cells: blankCells(WIDTH) }]);
    expect(await fake.readColumns(TRANSACTIONS_TAB, WIDTH)).toHaveLength(2);
  });
});
