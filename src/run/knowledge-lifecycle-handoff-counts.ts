import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type HandoffPacketCounts = { generated: number; missingReadme: number; unsafe: number; audited: number; auditPassed: number; auditFailed: number; unsafeRejected: number };

export async function countHandoffPackets(runDirs: string[]): Promise<HandoffPacketCounts> {
  const counts = { generated: 0, missingReadme: 0, unsafe: 0, audited: 0, auditPassed: 0, auditFailed: 0, unsafeRejected: 0 };
  for (const runDir of runDirs) {
    for (const path of await collectNamedFiles(runDir, "handoff.json")) await countHandoff(path, counts);
    for (const auditPath of await collectNamedFiles(runDir, "audit-result.json")) await countAudit(auditPath, counts);
  }
  return counts;
}

async function countHandoff(path: string, counts: HandoffPacketCounts): Promise<void> {
  counts.generated += 1;
  const root = path.replace(/\/handoff\.json$/, "");
  await readFile(join(root, "README.md"), "utf8").catch(() => { counts.missingReadme += 1; });
  try {
    const handoff = JSON.parse(await readFile(path, "utf8")) as { proposal?: { autoAppliedByRunForge?: boolean }; sourceRepo?: { originalRepoMutated?: boolean }; manualApply?: { allowedTarget?: string }; safety?: Record<string, unknown> };
    const unsafe = handoff.proposal?.autoAppliedByRunForge !== false ||
      handoff.sourceRepo?.originalRepoMutated !== false ||
      handoff.manualApply?.allowedTarget === "original_repo" ||
      ["providerUsed", "networkUsed", "dbUsed", "deployUsed", "pushUsed", "mergeUsed"].some((key) => handoff.safety?.[key] !== false);
    if (unsafe) counts.unsafe += 1;
  } catch {
    counts.unsafe += 1;
  }
}

async function countAudit(auditPath: string, counts: HandoffPacketCounts): Promise<void> {
  counts.audited += 1;
  try {
    const audit = JSON.parse(await readFile(auditPath, "utf8")) as { status?: string; safety?: { unsafeInstructionsFound?: boolean; forbiddenTargetsFound?: boolean }; findings?: string[] };
    if (audit.status === "passed") counts.auditPassed += 1;
    else counts.auditFailed += 1;
    const unsafeRejected = audit.status === "failed" && (audit.safety?.unsafeInstructionsFound === true || audit.safety?.forbiddenTargetsFound === true || (audit.findings ?? []).some((finding) => /unsafe|forbidden|original_repo|autoAppliedByRunForge/i.test(finding)));
    if (unsafeRejected) counts.unsafeRejected += 1;
  } catch {
    counts.auditFailed += 1;
  }
}

async function collectNamedFiles(root: string, name: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(root, entry.name);
    if (entry.isDirectory()) return collectNamedFiles(child, name);
    if (!entry.isFile()) return [];
    return entry.name === name ? [child] : [];
  }));
  return nested.flat();
}
