export type RegexReplacement = readonly [RegExp, string];

export function applyRegexReplacements(
  text: string,
  replacements: readonly RegexReplacement[],
) {
  return replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    String(text || ""),
  );
}
