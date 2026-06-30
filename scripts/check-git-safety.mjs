import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const requiredRulePhrases = [
  "One task = one branch/worktree",
  "Do not do non-trivial agent work directly on `main`",
  "Inspect git status and base commit before work",
  "Never commit unrelated dirty changes",
  "Never use `git add .` blindly",
  "No destructive git operations without explicit approval",
  "Make atomic commits",
  "Final reports must include git evidence",
  "Clean up worktrees only after merge or confirmation",
  "Starting a new agent task"
];

const dangerousPackageTerms = [
  "git add .",
  "git reset --hard",
  "git clean -fd",
  "git push --force",
  "git push -f"
];

const failures = [];
const warnings = [];

await checkDocsAndScripts();
checkGitContext();

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const failure of failures) console.error(`FAIL ${failure}`);

if (failures.length > 0) process.exit(1);
console.log("Git safety check passed.");

async function checkDocsAndScripts() {
  if (!existsSync("docs/git-worktree-rules.md")) {
    fail("Missing docs/git-worktree-rules.md.");
    return;
  }

  const rules = await readFile("docs/git-worktree-rules.md", "utf8");
  for (const phrase of requiredRulePhrases) {
    if (!rules.includes(phrase)) fail(`docs/git-worktree-rules.md must document: ${phrase}`);
  }

  const engineeringRules = await readFile("docs/engineering-rules.md", "utf8");
  if (!engineeringRules.includes("docs/git-worktree-rules.md")) {
    fail("docs/engineering-rules.md must reference docs/git-worktree-rules.md.");
  }
  if (!engineeringRules.includes("pnpm check:git-safety")) {
    fail("docs/engineering-rules.md must reference pnpm check:git-safety.");
  }

  const pkgText = await readFile("package.json", "utf8");
  const pkg = JSON.parse(pkgText);
  if (pkg.scripts?.["check:git-safety"] !== "node scripts/check-git-safety.mjs") {
    fail("package.json must define check:git-safety as node scripts/check-git-safety.mjs.");
  }
  const governance = pkg.scripts?.["check:governance"] ?? "";
  const dogfood = pkg.scripts?.dogfood ?? "";
  if (!governance.includes("check:git-safety") && !dogfood.includes("check:git-safety")) {
    fail("package.json must include check:git-safety in check:governance or dogfood.");
  }

  for (const term of dangerousPackageTerms) {
    if (pkgText.includes(term)) fail(`package.json must not contain dangerous or blind git command: ${term}`);
  }
}

function checkGitContext() {
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    fail("Run pnpm check:git-safety from inside a git worktree.");
    return;
  }

  const branch = git(["branch", "--show-current"]).stdout.trim() || "(detached)";
  const head = git(["rev-parse", "--short=12", "HEAD"]).stdout.trim();
  const status = git(["status", "--porcelain"]).stdout.trim();
  const isDirty = status.length > 0;
  const strict = process.env.RUNFORGE_GIT_SAFETY_STRICT === "1";

  console.log(`Git branch: ${branch}`);
  console.log(`Git HEAD: ${head}`);
  console.log(`Git status: ${isDirty ? "dirty" : "clean"}`);

  const base = git(["merge-base", "--short=12", "HEAD", "origin/main"]);
  if (base.status === 0) console.log(`Git base with origin/main: ${base.stdout.trim()}`);
  else warn("Could not determine merge-base with origin/main. This is expected before fetching remotes.");

  if ((branch === "main" || branch === "master") && isDirty) {
    const message = "Current worktree is dirty on the main branch. Move non-trivial agent work to an isolated branch/worktree.";
    if (strict) fail(message);
    else warn(message);
  }
}

function git(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? ""
    };
  }
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}
