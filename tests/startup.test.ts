import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

interface PackageJson {
  scripts: Record<string, string>;
}

// 這個 hook 會跑一次完整的 TypeScript 建置，而 vitest 的 hook 預設逾時是 10 秒 ——
// 在主機忙碌時（例如同時有幾個 docker build 在跑）根本跑不完，於是整個檔案以
// `Hook timed out in 10000ms` 失敗。M5a 驗收期間它這樣紅了四次，每一次都與程式對錯無關。
//
// **一個會因為與程式無關的理由變紅的測試，會訓練人忽略紅燈** —— 而紅燈代表真的有問題
// 這個約定，是這個專案花了兩個里程碑建立起來的，不值得為一個訂得太緊的期限消耗掉。
//
// 把逾時拉長不會掩蓋「建置真的變慢」：那一步在 `pnpm check` 鏈裡本來就會以
// `pnpm build` 獨立跑一次，而那一次沒有逾時。這裡的 10 秒從來不是效能守衛。
const BUILD_HOOK_TIMEOUT_MS = 180_000;

describe("production startup", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], {
      cwd: projectRoot,
    });
  }, BUILD_HOOK_TIMEOUT_MS);

  it("packages every database migration", () => {
    expect(
      existsSync(new URL("../dist/src/db/migrations/0002_accounting_core.sql", import.meta.url)),
    ).toBe(true);
  });

  it("starts the compiled application through the package start command", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageJson;
    const startCommand = packageJson.scripts.start;

    expect(startCommand).toBeDefined();
    if (!startCommand) {
      throw new Error("package.json must define a start script");
    }

    const result = spawnSync(startCommand, {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: "test-token",
        LEDGER_OWNER_ID: "1",
        DATABASE_PATH: ":memory:",
        LEDGER_STARTUP_CHECK: "1",
      },
      shell: true,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ledger Bot runtime ready");
    expect(result.stdout).not.toContain("test-token");
    expect(result.stdout).not.toContain("ownerId");
  });
});
