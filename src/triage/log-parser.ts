export function extractLogExcerpts(logText: string, max = 6): string[] {
  const lines = logText.split(/\r?\n/).filter(Boolean);
  const important = lines.filter((line) =>
    /error|fail|missing|TS\d{4}|AssertionError|ERR_|timeout|not found/i.test(line)
  );
  return (important.length > 0 ? important : lines).slice(0, max).map((line) => line.slice(0, 240));
}

export function extractMentionedFiles(logText: string): string[] {
  const matches = new Set<string>();
  const filePattern = /(?:\.\/)?[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|env|yml|yaml)/g;
  for (const match of logText.matchAll(filePattern)) {
    matches.add(match[0].replace(/^\.\//, ""));
  }
  return [...matches].slice(0, 12);
}
