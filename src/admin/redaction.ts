const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk-or-v1-[A-Za-z0-9._-]{12,})\b/g,
  /\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g,
  /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)([^"'\s,;]{6,})/gi,
  /\b(OPENROUTER_API_KEY\s*=\s*)([^\s]+)/gi
];

export function redactSecrets(value: string): string {
  let redacted = value;
  redacted = redacted.replace(SECRET_PATTERNS[0]!, "[REDACTED_PRIVATE_KEY]");
  redacted = redacted.replace(SECRET_PATTERNS[1]!, "Bearer [REDACTED]");
  redacted = redacted.replace(SECRET_PATTERNS[2]!, "[REDACTED_OPENROUTER_KEY]");
  redacted = redacted.replace(SECRET_PATTERNS[3]!, "[REDACTED_TOKEN]");
  redacted = redacted.replace(SECRET_PATTERNS[4]!, "$1[REDACTED]");
  redacted = redacted.replace(SECRET_PATTERNS[5]!, "$1[REDACTED]");
  return redacted;
}

export function redactJson<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}

export function redactedRef(ref: string | null | undefined): string {
  if (!ref) return "not configured";
  if (ref.startsWith("env:")) return ref;
  if (ref.startsWith("local:")) return "local:[REDACTED]";
  return redactSecrets(ref);
}
