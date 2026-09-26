import { describe, expect, it } from "vitest";

import { parseTransaction, type ParseResult } from "../../src/parser/rule-parser.js";
import { splitInput } from "../../src/parser/split-input.js";
import { parserCorpus, referenceSnapshotFixture } from "../fixtures/parser-corpus.js";

function parseSegment(segment: string, index: number): ParseResult {
  return parseTransaction(segment, {
    ownerId: "123",
    requestId: `request-${String(index)}`,
    sourceEventId: "event-1",
    draftId: `draft-${String(index)}`,
    allocationId: `allocation-${String(index)}`,
    additionalAllocationId: `allocation-fee-${String(index)}`,
    today: "2026-09-21",
    ...referenceSnapshotFixture(),
  });
}

// 配置筆數是這份語料真正要釘住的東西：kind 相同但配置為空的 missing_fields，
// 會被 create-batch 降級成「無法解析」，追問流程整條消失。
function allocationCount(result: ParseResult): number {
  return result.kind === "draft"
    ? result.draft.allocations.length
    : result.partial.allocations.length;
}

describe("parser corpus", () => {
  it("covers at least twenty-five anonymised inputs", () => {
    expect(parserCorpus.length).toBeGreaterThanOrEqual(25);
  });

  it("declares one expected allocation count per segment", () => {
    for (const testCase of parserCorpus) {
      expect(testCase.allocationCounts).toHaveLength(testCase.outcomes.length);
      expect(testCase.outcomes).toHaveLength(testCase.segments);
    }
  });

  it.each(parserCorpus)("parses $input consistently", (testCase) => {
    const segments = splitInput(testCase.input);

    expect(segments).toHaveLength(testCase.segments);
    const parsed = segments.map((segment, index) => parseSegment(segment, index));
    expect(parsed.map((result) => result.kind)).toEqual(testCase.outcomes);
    expect(parsed.map((result) => allocationCount(result))).toEqual(testCase.allocationCounts);
  });
});
