import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

interface PackageJson {
  scripts: Record<string, string>;
}

describe("production startup", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], {
      cwd: projectRoot,
    });
  });

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
