import { describe, expect, it, vi } from "vitest";

import { getMonthSummary, getTodaySummary } from "../../src/application/ledger-summary.js";
import { summarizeAllocations } from "../../src/domain/ledger-summary.js";

describe("ledger summary services", () => {
  it("uses today as both inclusive boundaries", async () => {
    const summarize = vi.fn().mockResolvedValue(summarizeAllocations([]));
    await getTodaySummary("owner-1", { repository: { summarize }, today: () => "2026-09-18" });
    expect(summarize).toHaveBeenCalledWith("owner-1", {
      from: "2026-09-18",
      to: "2026-09-18",
    });
  });

  it("uses the first calendar day through today for a month", async () => {
    const summarize = vi.fn().mockResolvedValue(summarizeAllocations([]));
    await getMonthSummary("owner-1", { repository: { summarize }, today: () => "2026-09-18" });
    expect(summarize).toHaveBeenCalledWith("owner-1", {
      from: "2026-09-01",
      to: "2026-09-18",
    });
  });
});
