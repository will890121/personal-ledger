import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [".worktrees", "coverage", "dist", "node_modules"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-import-type-side-effects": "error",
      // 全部日誌都要走 src/logger.ts 那個唯一、會做遮罩的出口——見 AC-28。
      // 只排除這一個檔案，不排除整個目錄，否則這條規則等於形同虛設。
      "no-console": "error",
    },
  },
  {
    files: ["src/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // 這一個檔案的 console.error 不是應用程式日誌，是印給正在手動執行
    // `pnpm test:sheets` 的人看的：在真正清空試算表之前，把它即將清空的 id
    // 印出來、以及正式試算表變數缺席時大聲說「我無法確認」。走 src/logger.ts
    // 反而是錯的——logger 的拒絕清單本來就會遮掉 spreadsheetId，而這裡的目的
    // 正好是要讓人看見它。
    files: ["tests/integration/sheets.integration.test.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // ── 分層邊界（AC 邊界）───────────────────────────────────────────────────
  //
  // 這三條規則本來只寫在文件與程式碼註解裡，靠「送審時逐條 grep 核過」成立——
  // 那是一次性的確認，不是約束。整分支審查同時做了三件違規（grammY 進
  // `src/sheets/sheet-failure.ts`、googleapis 進 `src/domain/sheet-rows.ts`、
  // grammY 進 `src/logger.ts`），`pnpm check` 依然 exit 0、全綠。下面把它們
  // 變成 lint 錯誤：約定寫在註解裡會過期，寫在這裡不會。
  //
  // 用 `@typescript-eslint` 的版本而不是基礎規則：它的 `allowTypeImports`
  // 預設是 false，所以 `import type { Bot } from "grammy"` 一樣被擋。刻意如此——
  // 邊界要擋的是「這一層知道下一層存在」，而型別 import 一樣會把那份知識帶進來
  // （`grammy/types` 的鍵盤型別就是這樣一路長進 domain 的最短路徑）。
  //
  // `grammy/*`／`googleapis/*` 也要一起寫進 group：只擋裸名稱的話，
  // `grammy/types` 這種子路徑會整條繞過去。
  {
    files: ["src/domain/**/*.ts", "src/application/**/*.ts", "src/ports/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["grammy", "grammy/*", "googleapis", "googleapis/*"],
              message:
                "domain／application／ports 不得依賴 grammY 或 googleapis：這三層是純邏輯與契約，要能在沒有 Telegram、沒有 Google 的情形下單獨測試。需要外部型別時，在 ports 定義自己收窄過的介面，由 src/telegram/ 或 src/sheets/ 去接。",
            },
          ],
        },
      ],
    },
  },
  {
    // `src/sheets/` 不得依賴 grammY；googleapis 只有 google-sheets-client.ts
    // 一個入口（見該檔案開頭的說明），其餘檔案一律不得直接碰。
    files: ["src/sheets/**/*.ts"],
    ignores: ["src/sheets/google-sheets-client.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["grammy", "grammy/*"],
              message:
                "src/sheets/ 不得依賴 grammY：鏡像不知道通知管道是 Telegram（`onNeedsAttention`／`logError` 都是注入進來的函式）。需要送訊息或記日誌時，收窄成一個函式簽章讓 main.ts 注入。",
            },
            {
              group: ["googleapis", "googleapis/*"],
              message:
                "googleapis 只有 src/sheets/google-sheets-client.ts 一個入口：失敗分類（sheet-failure.ts）刻意用鴨子定型讀狀態碼，就是為了不在那裡開第二個入口。",
            },
          ],
        },
      ],
    },
  },
  {
    // 唯一允許 import googleapis 的檔案，但 grammY 仍然不行。
    files: ["src/sheets/google-sheets-client.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["grammy", "grammy/*"],
              message: "src/sheets/ 不得依賴 grammY。",
            },
          ],
        },
      ],
    },
  },
  {
    // `src/logger.ts` 是全專案唯一的日誌出口，每一層都會 import 它——它一旦
    // 依賴 grammY，grammY 就等於進了 domain／ports／sheets 的依賴圖裡。
    files: ["src/logger.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["grammy", "grammy/*"],
              message:
                "src/logger.ts 不得依賴 grammY：每一層都 import 這個檔案，它的依賴就是所有層的依賴。要判斷 GrammyError 請放在 src/telegram/（delivery-error.ts 就是為此存在）。",
            },
          ],
        },
      ],
    },
  },
  {
    // 「googleapis 只有 google-sheets-client.ts 一個入口」這句話在上面的
    // src/sheets/ zone 裡只管到 src/sheets/ 目錄本身——src/db/、src/parser/、
    // src/telegram/、src/main.ts、src/config.ts、src/timezone.ts、
    // src/logger.ts 都不在那個 zone 管轄範圍內，googleapis import 放進去一樣
    // 會通過 lint。這一條補的就是那句約束真正該有的範圍：整個 src/**，
    // 只留 google-sheets-client.ts 一個例外。
    files: ["src/**/*.ts"],
    ignores: ["src/sheets/google-sheets-client.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["googleapis", "googleapis/*"],
              message:
                "googleapis 只有 src/sheets/google-sheets-client.ts 一個入口：其餘檔案一律不得直接依賴它，需要 Sheets 能力時透過 ports 收窄過的介面呼叫。",
            },
          ],
        },
      ],
    },
  },
]);

// 這份設定擋得住的是「這個檔案自己的 import 行」，不是依賴圖：A 檔案沒有直接
// import googleapis／grammY，但它 import 了另一個違規 import 的檔案，這條規則
// 一樣會放行——那是傳遞路徑，no-restricted-imports 看不到。動態 import()
// 也一樣不設防，同一個理由。這是刻意的取捨，不是漏洞：要擋傳遞路徑得換成
// no-restricted-paths 或 dependency-cruiser，那是新依賴加新設定，而這個專案裡
// 動態 import googleapis 沒有任何理由會發生、傳遞路徑則會先被 code review 看到，
// 代價超過它消除的風險。一條宣稱自己擋得比實際多的規則，比沒有規則更危險。
