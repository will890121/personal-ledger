import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/logger.js";
import { main } from "../src/main.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("application entrypoint", () => {
  it("guards the process against a stray unhandled rejection", async () => {
    // C1 的第二層（縱深防禦）：漏接的 promise 拒絕在 Node 24 的預設下會殺掉行程，
    // 而 compose.yaml 是 restart: unless-stopped——無盡的 crash loop。這裡驗證
    // main() 真的裝了這個 listener、它會走 logger、而且不會結束行程。
    const directory = mkdtempSync(join(tmpdir(), "personal-ledger-main-"));
    temporaryDirectories.push(directory);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const before = new Set(process.listeners("unhandledRejection"));

    await main({
      TELEGRAM_BOT_TOKEN: "123456:test-token",
      LEDGER_OWNER_ID: "123",
      DATABASE_PATH: join(directory, "ledger.sqlite"),
      LEDGER_STARTUP_CHECK: "1",
    });

    const installed = process
      .listeners("unhandledRejection")
      .filter((listener) => !before.has(listener));
    try {
      expect(installed).toHaveLength(1);

      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      const exitCodeBefore = process.exitCode;
      const reason = new Error("nobody caught me");

      installed[0]?.(
        reason,
        Promise.reject(reason).catch(() => undefined),
      );

      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0]?.[0]).toBe("unhandled promise rejection");
      expect(errorSpy.mock.calls[0]?.[1]).toEqual({ error: reason });
      // 記一行就好，不能順手把行程也收掉——那就是我們要避免的 crash loop。
      expect(process.exitCode).toBe(exitCodeBefore);
    } finally {
      for (const listener of installed) {
        process.removeListener("unhandledRejection", listener);
      }
    }
  });
});
