const SECRET_PATTERNS = [
  /\.env\s*=/i,
  /private key/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{12,}/i,
  /\b(?:ghp|github_pat|sk|xox[baprs])_[A-Za-z0-9_\-]{16,}/
];

export function findSecretLikeContent(content: string): string[] {
  return SECRET_PATTERNS.filter((pattern) => pattern.test(content)).map((pattern) => pattern.source);
}
