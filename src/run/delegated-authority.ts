import { appendFile, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type AuthorityClassification = "accepted" | "missing" | "invalid" | "stale" | "too_broad" | "too_narrow" | "mismatched" | "expired";
export type AuthorityEnvelope = { authority_id: string; scope: string; repo: string; allowed_actions: Record<string, boolean>; forbidden_actions: Record<string, boolean>; allowed_patch_risk: { max_risk: "low"; allowed_file_patterns: string[]; forbidden_file_patterns: string[] }; controlled_apply: { allowed: boolean; mode: "artifact-contained-worktree"; branch_name: string; requires_source_clean: boolean }; local_branch_apply?: { allowed: boolean; mode: "local-non-main-branch"; branch_name: string; requires_source_clean: boolean }; expires_at: string | null; owner_note: string };
export type AuthorityDecision = { timestamp: string; authority_id?: string; run_id: string; action: string; decision: "continue" | "stop"; classification: AuthorityClassification; reason: string; repo: string; target_mode?: string; risk?: string; patch_package_hash?: string; patch_diff_hash?: string };
const requiredActions = ["prepare_runtime", "run_baseline_validation", "perform_disposable_repair", "generate_patch_package", "run_providerless_review", "apply_to_controlled_artifact_worktree", "run_after_apply_validation", "generate_pr_creation_package"];
const hardForbidden = ["mutate_source_repo", "target_main_or_master", "push", "merge", "deploy", "provider_calls", "db_access", "production_access", "secret_access", "runtime_network", "create_external_pr"];

export async function loadAuthority(path: string | undefined, repo: string): Promise<{ classification: AuthorityClassification; envelope?: AuthorityEnvelope; reason: string }> {
  if (!path) return { classification: "missing", reason: "No authority envelope was provided." };
  let value: unknown;
  try { value = JSON.parse(await readFile(resolve(path), "utf8")); } catch (error) { return { classification: "invalid", reason: `Authority envelope could not be parsed: ${error instanceof Error ? error.message : String(error)}` }; }
  if (!isEnvelope(value)) return { classification: "invalid", reason: "Authority envelope is malformed or incomplete." };
  let target: string; let canonicalRepo: string;
  try { [target, canonicalRepo] = await Promise.all([realpath(value.repo), realpath(repo)]); } catch { return { classification: "mismatched", reason: "Authority repository does not resolve." }; }
  if (target !== canonicalRepo) return { classification: "mismatched", reason: "Authority repository does not match the canonical target repository." };
  if (value.expires_at !== null) { const expiry = Date.parse(value.expires_at); if (!Number.isFinite(expiry)) return { classification: "invalid", reason: "Authority expiry is invalid." }; if (expiry <= Date.now()) return { classification: "expired", reason: "Authority envelope has expired." }; }
  if (hardForbidden.some((name) => value.forbidden_actions[name] !== true)) return { classification: "too_broad", reason: "Authority attempts to relax a hard safety boundary." };
  if (hardForbidden.some((name) => value.allowed_actions[name] === true)) return { classification: "too_broad", reason: "Authority explicitly allows a hard-forbidden action." };
  if (requiredActions.some((name) => value.allowed_actions[name] !== true) || !value.controlled_apply.allowed) return { classification: "too_narrow", reason: "Authority does not cover the delegated action class." };
  if (value.controlled_apply.mode !== "artifact-contained-worktree" || ["main", "master"].includes(value.controlled_apply.branch_name.toLowerCase())) return { classification: "too_broad", reason: "Authority controlled target is unsafe." };
  return { classification: "accepted", envelope: value, reason: "Authority is valid and bound to the canonical target." };
}

export function evaluatePatchAuthority(envelope: AuthorityEnvelope, input: { files: string[]; risk: "low"; controlledPath: string; sourceRepo: string }): { classification: AuthorityClassification; reason: string } {
  if (envelope.expires_at !== null && Date.parse(envelope.expires_at) <= Date.now()) return { classification: "expired", reason: "Authority expired before the controlled apply decision." };
  const inside = relative(resolve(input.sourceRepo), resolve(input.controlledPath));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return { classification: "mismatched", reason: "Controlled apply target resolves inside the source repository." };
  for (const file of input.files) { if (envelope.allowed_patch_risk.forbidden_file_patterns.some((p) => matches(p, file))) return { classification: "too_broad", reason: `Patch file is forbidden: ${file}` }; if (!envelope.allowed_patch_risk.allowed_file_patterns.some((p) => matches(p, file))) return { classification: "too_narrow", reason: `Patch file is outside delegated patterns: ${file}` }; }
  return { classification: "accepted", reason: "Low-risk patch and artifact-contained target are covered." };
}
export async function recordAuthorityDecision(path: string, decision: AuthorityDecision): Promise<void> { await appendFile(path, JSON.stringify(decision) + "\n", "utf8"); }
export async function writeAuthorityReport(path: string, decisions: AuthorityDecision[]): Promise<void> { await writeFile(path, `# Authority Report\n\n${decisions.map((d) => `- ${d.timestamp} — \`${d.action}\`: **${d.decision}** (${d.classification}) — ${d.reason}`).join("\n")}\n`, "utf8"); }
function isEnvelope(value: unknown): value is AuthorityEnvelope { if (!value || typeof value !== "object") return false; const v = value as Partial<AuthorityEnvelope>; return typeof v.authority_id === "string" && !!v.authority_id && typeof v.scope === "string" && typeof v.repo === "string" && !!v.allowed_actions && !!v.forbidden_actions && !!v.allowed_patch_risk && v.allowed_patch_risk.max_risk === "low" && Array.isArray(v.allowed_patch_risk.allowed_file_patterns) && Array.isArray(v.allowed_patch_risk.forbidden_file_patterns) && !!v.controlled_apply && typeof v.controlled_apply.allowed === "boolean" && typeof v.controlled_apply.branch_name === "string" && typeof v.controlled_apply.requires_source_clean === "boolean" && (v.expires_at === null || typeof v.expires_at === "string") && typeof v.owner_note === "string" && !!v.owner_note.trim(); }
function matches(pattern: string, file: string): boolean { const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "::D::").replaceAll("*", "[^/]*").replaceAll("::D::", ".*"); return new RegExp(`^${escaped}$`).test(file); }
