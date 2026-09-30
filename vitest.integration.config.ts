import { defineConfig } from "vitest/config";

/**
 * 只給 `pnpm test:sheets` 用：唯一會去打真實 Google Sheets API 的那一組測試。
 *
 * 與 `vitest.config.ts` 分開兩份檔案，而不是在同一份裡靠環境變數切換：切換式的設定
 * 有一個預設分支，而預設分支遲早會把整合測試帶回 `pnpm check` 裡（那正是排除它的理由）。
 * 兩份檔案的 include 互斥，哪一組測試會跑就是看命令，不看環境。
 *
 * testTimeout 放寬到 60 秒：一次來回是好幾筆真實的 HTTPS 呼叫，vitest 預設的 5 秒
 * 在網路稍慢時會變成偽陰性——而偽陰性會讓人開始忽略這個指令。
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 同一張拋棄式試算表同時被兩個 worker 清空並重寫，兩邊都會讀到對方寫的列。
    // 這組測試本來就是序列的來回，並行沒有任何好處。
    fileParallelism: false,
  },
});
