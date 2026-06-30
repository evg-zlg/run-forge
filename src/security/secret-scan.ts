import type { SecretMatch, SecretScanResult } from "../core/types.js";

const rules: Array<{ type: string; pattern: RegExp }> = [
  { type: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { type: "openai_like_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { type: "generic_secret", pattern: /\b(SECRET|TOKEN|PASSWORD|API_KEY)\s*=\s*['"]?[^'"\s]{8,}/i },
  { type: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
];

export function scanSecrets(text: string): SecretScanResult {
  const matches: SecretMatch[] = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(lineText)) {
        matches.push({
          type: rule.type,
          line: index + 1,
          preview: redactLine(lineText)
        });
      }
    }
  });
  return { status: matches.length > 0 ? "failed" : "passed", matches };
}

export function redactLine(line: string): string {
  const assignment = line.match(/^(\s*(?:SECRET|TOKEN|PASSWORD|API_KEY)\s*=\s*['"]?)([^'"\s]+)(.*)$/i);
  if (assignment) return `${assignment[1]}${redactValue(assignment[2])}${assignment[3]}`;
  return line.replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9_\-=]{6,}([A-Za-z0-9_-]{4})/g, "$1...$2");
}

function redactValue(value: string): string {
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
