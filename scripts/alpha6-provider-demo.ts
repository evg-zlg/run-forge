import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderExternalCodeProposalCliSummary, runExternalCodeProposal } from "../src/run/external-code-proposal.js";

const execFileAsync = promisify(execFile);

const repo = await mkdtemp(join(tmpdir(), "runforge-alpha6-provider-demo-repo-"));
await writeFile(join(repo, "state.txt"), "bad\n", "utf8");
await execFileAsync("git", ["init"], { cwd: repo });
await execFileAsync("git", ["add", "."], { cwd: repo });
await execFileAsync("git", ["-c", "user.name=RunForge Demo", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: repo });

const patch = [
  "diff --git a/state.txt b/state.txt",
  "--- a/state.txt",
  "+++ b/state.txt",
  "@@ -1 +1 @@",
  "-bad",
  "+good",
  ""
].join("\n");

const out = "./artifacts/runs/external-provider-proposal-demo";
const result = await runExternalCodeProposal({
  repo,
  commands: [
    "node -e \"const fs=require('fs'); if (fs.readFileSync('state.txt','utf8').trim()==='good') process.exit(0); console.error('AssertionError: expected state to be good'); process.exit(1);\""
  ],
  out,
  runId: "external-provider-proposal-demo",
  enableProviderProposal: true,
  provider: "cli",
  providerCommand: `node -e 'require("fs").writeFileSync("provider-output.patch", ${JSON.stringify(patch)})'`
});

console.log(renderExternalCodeProposalCliSummary(result));
