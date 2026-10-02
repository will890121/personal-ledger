import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // 整合測試要打真實 Google API。真實網路進了單元測試套件，套件就會隨機變紅，
    // 而一個會無故紅的套件三週後就沒人看——那比沒有套件更糟。改用 pnpm test:sheets
    // 單獨跑，並列入 M5a 的通過條件。
    //
    // 明寫 node_modules 與 dist：`exclude` 一旦給了值就是整份取代 vitest 的預設清單，
    // 只寫 `tests/integration/**` 會讓 dist/ 裡建置產物的 .test.js 一起被撈進來。
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
  },
});
