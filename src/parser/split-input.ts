const SEPARATORS = /[,，、\n]/;
const HAS_AMOUNT = /\d/;

export function splitInput(text: string): string[] {
  const segments = text
    .split(SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const merged: string[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (!HAS_AMOUNT.test(segment) && previous !== undefined) {
      merged[merged.length - 1] = `${previous}，${segment}`;
      continue;
    }
    merged.push(segment);
  }

  const [first, second, ...rest] = merged;
  if (first !== undefined && second !== undefined && !HAS_AMOUNT.test(first)) {
    return [`${first}，${second}`, ...rest];
  }
  return merged;
}
