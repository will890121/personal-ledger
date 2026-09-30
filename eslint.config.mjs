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
]);
