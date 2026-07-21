import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { CampaignPlan, CampaignPlanNode, CampaignSpec } from "../control-plane/contracts.js";
import {
  executeOpenRouterChatCompletion,
  type OpenRouterExecutionRequest,
  type OpenRouterExecutionResult,
} from "../providers/openrouter-execution-provider.js";
import { detectCycle } from "./campaign-validation.js";
import { planCampaignFromGoal } from "./task-run-planner.js";

type DraftNode = {
  id: string;
  goal: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  explicitFiles: string[];
  writeScopes: string[];
  estimatedTokens: number;
  estimatedCostUsd?: number;
};
export type CampaignPlannerEvidence = {
  mode: "deterministic-local" | "semantic-openrouter";
  model: string | null;
  attempts: number;
  repaired: boolean;
  usage: { tokens: number; costUsd: number };
  validationCodes: string[];
};
export type SemanticCampaignPlannerResult = { plan: CampaignPlan; evidence: CampaignPlannerEvidence };
export class SemanticCampaignPlannerError extends Error {
  constructor(readonly evidence: CampaignPlannerEvidence) {
    super(`semantic_campaign_planning_failed:${evidence.validationCodes.join(",")}`);
    this.name = "SemanticCampaignPlannerError";
  }
}
type Chat = (request: OpenRouterExecutionRequest) => Promise<OpenRouterExecutionResult>;
type Options = { chatCompletion?: Chat; repositoryManifest?: unknown };

const draftKeys = new Set(["id", "goal", "acceptanceCriteria", "dependsOn", "explicitFiles", "writeScopes", "estimatedTokens", "estimatedCostUsd"]);
const excludedPath = /(^|\/)(?:\.git|\.env(?:\..*)?|node_modules|dist|coverage|artifacts|validation\/runs|\.runforge|secrets?|credentials?)(\/|$)/i;

export async function planSemanticCampaign(campaignId: string, spec: CampaignSpec, options: Options = {}): Promise<SemanticCampaignPlannerResult> {
  if (spec.providerRouting.provider === "local") return { plan: planCampaignFromGoal(campaignId, spec), evidence: emptyEvidence("deterministic-local", null) };
  const model = spec.providerRouting.phaseModels?.planner ?? spec.providerRouting.model ?? "qwen/qwen3-coder-next";
  const chat = options.chatCompletion ?? executeOpenRouterChatCompletion;
  const manifest = options.repositoryManifest ?? await buildRepositoryManifest(spec);
  const prompt = planningPrompt(spec, manifest);
  const usage = { tokens: 0, costUsd: 0 };
  const first = await invoke(chat, model, prompt, spec, usage, 1, false);
  const checked = validateDraft(first.content, spec);
  if (checked.nodes) return { plan: trustedPlan(campaignId, spec, checked.nodes), evidence: { mode: "semantic-openrouter", model, attempts: 1, repaired: false, usage, validationCodes: checked.notices ?? [] } };
  const repair = repairPrompt(checked.codes, first.content, spec);
  const second = await invoke(chat, model, repair, spec, usage, 2, true);
  const repaired = validateDraft(second.content, spec);
  if (!repaired.nodes) throw new SemanticCampaignPlannerError({ mode: "semantic-openrouter", model, attempts: 2, repaired: true, usage, validationCodes: [...new Set([...checked.codes, ...repaired.codes])].sort() });
  return { plan: trustedPlan(campaignId, spec, repaired.nodes), evidence: { mode: "semantic-openrouter", model, attempts: 2, repaired: true, usage, validationCodes: [...new Set([...checked.codes, ...(repaired.notices ?? [])])].sort() } };
}

async function invoke(chat: Chat, model: string, content: string, spec: CampaignSpec, usage: { tokens: number; costUsd: number }, attempts: number, repaired: boolean): Promise<OpenRouterExecutionResult> {
  try {
    const result = await chat({ model, messages: [{ role: "system", content: "Return only strict JSON. Never emit TaskSpec, authority, credentials, prose, or markdown." }, { role: "user", content }], timeoutMs: 300_000, maxCalls: 1, temperature: 0, maxTokens: Math.min(12_000, Math.max(1_000, Math.floor(spec.limits.maxTokens / 3))), reasoning: { effort: "low", exclude: true } });
    usage.tokens += result.usage.totalTokens ?? 0;
    usage.costUsd += result.usage.costUsd ?? 0;
    return result;
  } catch {
    throw new SemanticCampaignPlannerError({ mode: "semantic-openrouter", model, attempts, repaired, usage, validationCodes: ["MODEL_CALL_FAILED"] });
  }
}

function validateDraft(content: string, spec: CampaignSpec): { nodes?: DraftNode[]; codes: string[]; notices?: string[] } {
  let value: unknown;
  try { value = JSON.parse(extractJson(content)); } catch { return { codes: ["INVALID_JSON"] }; }
  const root = object(value);
  if (root && Object.keys(root).some((key) => key !== "nodes")) return { codes: ["INVALID_FIELDS"] };
  const raw: unknown[] | null = Array.isArray(value) ? value : root && Array.isArray(root.nodes) ? root.nodes : null;
  if (!raw?.length) return { codes: ["NO_NODES"] };
  const codes = new Set<string>();
  if (raw.length > spec.limits.maxTasks) codes.add("MAX_TASKS_EXCEEDED");
  const nodes: DraftNode[] = [];
  for (const item of raw) {
    const node = object(item);
    if (!node || Object.keys(node).some((key) => !draftKeys.has(key))) { codes.add("INVALID_FIELDS"); continue; }
    let valid = true;
    if (!validId(node.id)) { codes.add("INVALID_ID"); valid = false; }
    if (!nonEmpty(node.goal)) { codes.add("INVALID_GOAL"); valid = false; }
    if (!strings(node.acceptanceCriteria, true)) { codes.add("INVALID_CRITERIA"); valid = false; }
    if (!strings(node.dependsOn)) { codes.add("INVALID_DEPENDENCIES"); valid = false; }
    if (!strings(node.explicitFiles)) { codes.add("INVALID_FILE_LIST"); valid = false; }
    if (!strings(node.writeScopes)) { codes.add("INVALID_WRITE_SCOPES"); valid = false; }
    if (!Number.isInteger(node.estimatedTokens) || Number(node.estimatedTokens) < 1_000) { codes.add("INVALID_TOKEN_ESTIMATE"); valid = false; }
    if (node.estimatedCostUsd !== undefined && (!finite(node.estimatedCostUsd) || Number(node.estimatedCostUsd) < 0)) { codes.add("INVALID_COST_ESTIMATE"); valid = false; }
    if (!valid) continue;
    const explicitFiles = node.explicitFiles as string[], writeScopes = node.writeScopes as string[];
    if ([...explicitFiles, ...writeScopes].some((file) => !safePath(file))) codes.add("UNSAFE_FILE_SCOPE");
    nodes.push({ id: node.id as string, goal: node.goal as string, acceptanceCriteria: node.acceptanceCriteria as string[], dependsOn: node.dependsOn as string[], explicitFiles, writeScopes, estimatedTokens: Number(node.estimatedTokens), ...(node.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: Number(node.estimatedCostUsd) }) });
  }
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) codes.add("DUPLICATE_ID");
  if (nodes.some((node) => node.dependsOn.some((id) => !ids.has(id) || id === node.id))) codes.add("INVALID_DEPENDENCY");
  if (!codes.has("INVALID_DEPENDENCY") && detectCycle(nodes).length) codes.add("CYCLE");
  if (hasConcurrentOverlap(nodes)) codes.add("OVERLAPPING_SCOPE");
  if (spec.authority.implementation) { const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn)); const sinks = nodes.filter((node) => !dependedOn.has(node.id)); if (!sinks.some((node) => /test|valid|verif|check/i.test(`${node.goal} ${node.acceptanceCriteria.join(" ")}`))) codes.add("MISSING_FINAL_VALIDATION"); }
  const notices: string[] = [];
  if (nodes.length * 1_000 > Math.floor(spec.limits.maxTokens * .8)) codes.add("MINIMUM_CHILD_BUDGET_EXCEEDED");
  if (!codes.size) normalizeEstimates(nodes, spec, notices);
  return codes.size ? { codes: [...codes].sort() } : { nodes, codes: [], notices };
}

function trustedPlan(campaignId: string, spec: CampaignSpec, draft: DraftNode[]): CampaignPlan {
  const defaultModel = spec.providerRouting.phaseModels?.implementer ?? spec.providerRouting.model ?? "openrouter/auto";
  const models = { planner: spec.providerRouting.phaseModels?.planner ?? defaultModel, implementer: defaultModel, repair: spec.providerRouting.phaseModels?.repair ?? defaultModel, reviewer: spec.providerRouting.phaseModels?.reviewer ?? defaultModel };
  const nodes: CampaignPlanNode[] = draft.map((node, index) => {
    const childId = `${campaignId}_${String(index + 1).padStart(2, "0")}`.slice(0, 80);
    const total = Math.max(1_000, Math.min(200_000, node.estimatedTokens));
    const mode = spec.authority.implementation && node.writeScopes.length ? "implementation" : /test|valid|verif|check/i.test(`${node.goal} ${node.acceptanceCriteria.join(" ")}`) ? "validation" : "inspection";
    const boundedText = node.writeScopes.length ? `${node.goal}\nAllowed write scopes: ${node.writeScopes.join(", ")}. All other explicit files are read-only reference context.` : `${node.goal}\nThis is a read-only ${mode} node. Do not produce or apply a patch.`;
    return { id: node.id, dependsOn: node.dependsOn, writeScopes: node.writeScopes, estimatedTokens: node.estimatedTokens, ...(node.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: node.estimatedCostUsd }), taskSpec: {
      schemaVersion: 2, taskId: childId, task: { text: boundedText, goal: node.goal, acceptanceCriteria: node.acceptanceCriteria }, target: { repository: spec.target.repository ?? ".", workingDirectory: spec.target.workingDirectory ?? ".", ...(spec.target.expectedSha ? { expectedSha: spec.target.expectedSha } : {}) },
      execution: { mode, maxRepairIterations: 1, timeoutMs: 300_000, maxChangedFiles: 20, maxPatchBytes: 500_000, maxProviderTokens: total, budgetMode: "hard", phaseBudgets: phaseBudget(total) },
      providerRouting: { provider: "openrouter", models, maxCalls: 3, tokenBudget: { total, perPhase: providerBudget(total) }, ...(node.estimatedCostUsd === undefined ? {} : { costBudgetUsd: node.estimatedCostUsd }), timeoutMs: 300_000, retry: { maxAttempts: 1 }, fallbackPolicy: "none" },
      authority: { profile: mode === "implementation" ? "bounded-implementation" : "read-only", envelopeFile: null, forbiddenAreas: ["merge", "deploy", "database", "production", "secrets"], allowProviderCalls: mode === "implementation" && Boolean(spec.authority.providerCalls), allowNetwork: mode === "implementation" && Boolean(spec.authority.network) }, runtime: { preference: "local-disposable", dependencyPreparation: "if-needed", externalNetwork: mode === "implementation" && spec.authority.network ? "allowed" : "denied" }, git: { publication: "none", branch: null }, merge: { policy: "never" }, deploy: { policy: "never" },
      discovery: { policy: "explicit", profile: "small-scope", explicitFiles: [...new Set([...node.explicitFiles, ...node.writeScopes])], maxFiles: Math.max(1, Math.min(30, node.explicitFiles.length + node.writeScopes.length || 1)), maxBytes: 400_000, maxTokens: 30_000, stopCondition: "Stop when the bounded node acceptance criteria can be evaluated." }, validation: mode === "implementation" ? { mode: "explicit", commands: ["git diff --check"], requirements: [{ command: "git diff --check", capabilities: ["filesystem", "shell"], acceptance: "advisory", evidenceRole: "campaign-validation", fallbacks: [] }], profile: { id: "campaign-intermediate", defaultAcceptance: "advisory", defaultEvidenceRole: "campaign-validation", additionalCapabilities: [] } } : { mode: "auto", commands: [], requirements: [], profile: { id: "campaign-final", defaultAcceptance: "required", defaultEvidenceRole: "campaign-validation", additionalCapabilities: [] } }, ownerGate: { policy: "stop-and-report" }, repair: { mode: "none", plan: null }, artifacts: { root: `/tmp/runforge-campaign/${childId}`, resultFormat: "normalized-v1" }
    } };
  });
  return { schemaVersion: 1, campaignId, nodes, estimatedTokens: nodes.reduce((sum, node) => sum + (node.estimatedTokens ?? 0), 0), ...(spec.limits.maxCostUsd === undefined ? {} : { estimatedCostUsd: nodes.reduce((sum, node) => sum + (node.estimatedCostUsd ?? 0), 0) }) };
}

async function buildRepositoryManifest(spec: CampaignSpec): Promise<Record<string, unknown>> {
  const root = resolve(spec.target.repository ?? ".", spec.target.workingDirectory ?? ".");
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => { if (paths.length >= 160) return; for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const path = resolve(dir, entry.name); const rel = relative(root, path).replaceAll("\\", "/"); if (!rel || excludedPath.test(rel)) continue; if (entry.isDirectory()) await walk(path); else if (entry.isFile()) paths.push(rel); if (paths.length >= 160) break; } };
  await walk(root);
  let scripts: Record<string, string> = {};
  try { const pkg = object(JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))); if (object(pkg?.scripts)) scripts = Object.fromEntries(Object.entries(object(pkg!.scripts)!).filter((entry): entry is [string, string] => typeof entry[1] === "string").slice(0, 40)); } catch { /* optional manifest input */ }
  return { files: paths.sort(), scripts };
}

function planningPrompt(spec: CampaignSpec, manifest: unknown): string { return JSON.stringify({ goal: spec.goal, limits: spec.limits, repositoryManifest: manifest, output: { nodes: [{ id: "bounded-id", goal: "bounded goal", acceptanceCriteria: ["observable result"], dependsOn: [], explicitFiles: ["existing/reference/file"], writeScopes: ["only/file/or/directory/this/node/may/change"], estimatedTokens: 4000, estimatedCostUsd: 0.01 }] }, rules: ["Return one JSON object and no prose.", "explicitFiles are read context: include every existing reference/source file needed to make the decision, plus intended new files.", "writeScopes are the narrow paths this node may modify; validation-only nodes use an empty array.", "Use only manifest paths or safe new relative paths.", "Independent nodes must not share writeScopes.", "Reserve at least 20% of campaign token and cost limits for planning and repairs; child estimates together must use at most 80%.", "Implementation plans must end in a dependent validation/test/check node for the integrated result.", "Do not include authority, TaskSpec, merge, deploy, publication, credentials, or commands."] }).slice(0, 24_000); }
function repairPrompt(codes: string[], previous: string, spec: CampaignSpec): string { return JSON.stringify({ validationCodes: codes.slice(0, 20), previousDraft: previous.slice(0, 8_000), requiredShape: { nodes: [{ id: "unique-id", goal: "non-empty goal", acceptanceCriteria: ["non-empty observable criterion"], dependsOn: ["existing-node-id"], explicitFiles: ["existing reference/read context and intended new files"], writeScopes: ["only paths this node may modify; empty for validation"], estimatedTokens: "integer 1000 or greater", estimatedCostUsd: "optional finite non-negative number; omit when unknown" }] }, limits: { maxTasks: spec.limits.maxTasks, childTokensAtMost: Math.floor(spec.limits.maxTokens * .8), childCostAtMost: spec.limits.maxCostUsd === undefined ? null : spec.limits.maxCostUsd * .8 }, rules: ["Every dependency must name another emitted node.", "No self-dependencies or cycles.", "Independent nodes cannot share writeScopes.", "Read context must be sufficient for each node to act without owner clarification.", "Include a final dependent test/validation/check node.", "Use no unknown fields and return JSON only."], instruction: "Correct the draft without adding prose or markdown." }); }
function extractJson(text: string): string { const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i); return (fenced?.[1] ?? text).trim(); }
function hasConcurrentOverlap(nodes: DraftNode[]): boolean { const byId = new Map(nodes.map((node) => [node.id, node])); const reaches = (from: string, target: string, seen = new Set<string>()): boolean => from === target || (!seen.has(from) && (seen.add(from), (byId.get(from)?.dependsOn ?? []).some((dep) => reaches(dep, target, seen)))); for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) { const a = nodes[i]!, b = nodes[j]!; if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue; if (a.writeScopes.some((left) => b.writeScopes.some((right) => scopeOverlap(left, right)))) return true; } return false; }
function scopeOverlap(left: string, right: string): boolean { const a = left.replace(/\/$/, ""), b = right.replace(/\/$/, ""); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function normalizeEstimates(nodes: DraftNode[], spec: CampaignSpec, notices: string[]): void { const tokenCap = Math.floor(spec.limits.maxTokens * .8), tokenTotal = nodes.reduce((sum, node) => sum + node.estimatedTokens, 0); if (tokenTotal > tokenCap) { const room = tokenCap - nodes.length * 1_000, weights = nodes.map((node) => Math.max(0, node.estimatedTokens - 1_000)), rawWeightTotal = weights.reduce((sum, value) => sum + value, 0), equal = rawWeightTotal === 0, denominator = equal ? nodes.length : rawWeightTotal; let assigned = 0; nodes.forEach((node, index) => { const extra = index === nodes.length - 1 ? room - assigned : Math.floor(room * (equal ? 1 : weights[index]!) / denominator); node.estimatedTokens = 1_000 + Math.max(0, extra); assigned += Math.max(0, extra); }); notices.push("TOKEN_ESTIMATES_NORMALIZED"); } const costCap = spec.limits.maxCostUsd === undefined ? null : spec.limits.maxCostUsd * .8, costTotal = nodes.reduce((sum, node) => sum + (node.estimatedCostUsd ?? 0), 0); if (costCap !== null && costTotal > costCap) { const ratio = costCap / costTotal; for (const node of nodes) if (node.estimatedCostUsd !== undefined) node.estimatedCostUsd = Number((node.estimatedCostUsd * ratio).toFixed(6)); notices.push("COST_ESTIMATES_NORMALIZED"); } }
function phaseBudget(total: number): Record<string, number> { return { startup: Math.floor(total * .03), analysis: Math.floor(total * .12), implementation: Math.floor(total * .55), validation: Math.floor(total * .1), repair: Math.floor(total * .12), review: Math.floor(total * .05), publication: 0 }; }
function providerBudget(total: number): Record<string, number> { const planner = Math.max(100, Math.floor(total * .2)), repair = Math.max(100, Math.floor(total * .15)), reviewer = Math.max(100, Math.floor(total * .1)); return { planner, implementer: Math.max(400, total - planner - repair - reviewer), repair, reviewer }; }
function safePath(value: string): boolean { return Boolean(value) && !value.startsWith("/") && !value.split("/").includes("..") && !excludedPath.test(value); }
function emptyEvidence(mode: CampaignPlannerEvidence["mode"], model: string | null): CampaignPlannerEvidence { return { mode, model, attempts: 0, repaired: false, usage: { tokens: 0, costUsd: 0 }, validationCodes: [] }; }
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function strings(value: unknown, nonEmpty = false): value is string[] { return Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every((item) => nonEmpty ? nonEmptyString(item) : typeof item === "string"); }
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function nonEmpty(value: unknown): value is string { return nonEmptyString(value); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
