import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CandidateIdentity = { id: string; source: string; file?: string; line?: number; evidence: string };
export type CandidateVerdict = {
  candidate_id: string;
  fingerprint: string;
  verdict: "reviewed_no_change";
  classification: "false_positive";
  reason: string;
  source_head: string;
  detector_evidence: string;
  file: string | null;
  checks: string[];
  recorded_at: string;
};

export async function candidateFingerprint(repo: string, candidate: CandidateIdentity): Promise<string> {
  const content = candidate.file ? await readFile(join(repo, candidate.file), "utf8") : "";
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    candidate_id: candidate.id,
    detector: candidate.source,
    detector_evidence: candidate.evidence,
    file: candidate.file ?? null,
    file_content_sha256: createHash("sha256").update(content).digest("hex")
  })).digest("hex");
}

export async function readCandidateHistory(cacheRoot: string, projectKey: string): Promise<CandidateVerdict[]> {
  try { return JSON.parse(await readFile(historyPath(cacheRoot, projectKey), "utf8")) as CandidateVerdict[]; }
  catch { return []; }
}

export async function saveCandidateVerdict(cacheRoot: string, projectKey: string, verdict: CandidateVerdict): Promise<string> {
  const path = historyPath(cacheRoot, projectKey); const history = await readCandidateHistory(cacheRoot, projectKey);
  const retained = history.filter((item) => !(item.candidate_id === verdict.candidate_id && item.fingerprint === verdict.fingerprint));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify([...retained, verdict], null, 2)}\n`);
  return path;
}

function historyPath(cacheRoot: string, projectKey: string) { return join(cacheRoot, projectKey, "candidate-history.json"); }
