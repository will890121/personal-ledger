import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

interface PackageJson {
  scripts: Record<string, string>;
}

describe("production startup", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], {
      cwd: projectRoot,
    });
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
      },
      shell: true,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ledger Bot configuration loaded");
  });
});
