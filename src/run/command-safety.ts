export interface CommandBlock {
  blocked: true;
  reason: string;
}

const blockedPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "sudo", pattern: /(^|[;&|()\s])sudo($|[;&|()\s])/ },
  { name: "rm -rf", pattern: /(^|[;&|()\s])rm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*($|[;&|()\s])/ },
  { name: "git reset --hard", pattern: /(^|[;&|()\s])git\s+reset\s+--hard($|[;&|()\s])/ },
  { name: "git clean -fd", pattern: /(^|[;&|()\s])git\s+clean\s+-[A-Za-z]*f[A-Za-z]*d[A-Za-z]*($|[;&|()\s])/ },
  { name: "curl | sh", pattern: /(^|[;&|()\s])curl\b[^|]*\|\s*(?:sh|bash)\b/ },
  { name: "wget | sh", pattern: /(^|[;&|()\s])wget\b[^|]*\|\s*(?:sh|bash)\b/ }
];

export function validateCommandSafety(command: string): CommandBlock | undefined {
  const normalized = command.trim();
  const blocked = blockedPatterns.find((entry) => entry.pattern.test(normalized));
  if (!blocked) return undefined;
  return { blocked: true, reason: `Blocked dangerous command pattern: ${blocked.name}.` };
}
