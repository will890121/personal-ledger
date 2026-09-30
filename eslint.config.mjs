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
]);
