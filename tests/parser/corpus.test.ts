import { describe, expect, it } from "vitest";

import { parseTransaction, type ParseResult } from "../../src/parser/rule-parser.js";
import { splitInput } from "../../src/parser/split-input.js";
import { parserCorpus, referenceSnapshotFixture } from "../fixtures/parser-corpus.js";

function parseKind(segment: string, index: number): ParseResult["kind"] {
  return parseTransaction(segment, {
    ownerId: "123",
    requestId: `request-${String(index)}`,
    sourceEventId: "event-1",
    draftId: `draft-${String(index)}`,
    allocationId: `allocation-${String(index)}`,
    additionalAllocationId: `allocation-fee-${String(index)}`,
    today: "2026-09-21",
    ...referenceSnapshotFixture(),
  }).kind;
}

describe("parser corpus", () => {
  it("covers at least twenty anonymised inputs", () => {
    expect(parserCorpus.length).toBeGreaterThanOrEqual(20);
  });

  it.each(parserCorpus)("parses $input consistently", (testCase) => {
    const segments = splitInput(testCase.input);

    expect(segments).toHaveLength(testCase.segments);
    expect(segments.map((segment, index) => parseKind(segment, index))).toEqual(testCase.outcomes);
  });
});
