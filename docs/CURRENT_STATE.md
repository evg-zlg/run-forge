# RunForge Current State

Status date: 2026-07-11.

RunForge is currently a local, deterministic, artifact-first task-run harness. It has proven a providerless local Agent OS loop for bounded roadmap/code tasks: intake by CLI, deterministic planning/decomposition, disposable workspace snapshots, local shell executor dispatch, logs/artifacts, checks, deterministic review, and owner-ready summaries. It is not yet a complete portable Agent OS because runtime isolation, remote/VPS execution, provider-backed review, richer semantic planning, and apply/merge/deploy control remain gated or missing.

## Current North Star

RunForge / Factory is an Agent OS: a portable task execution factory.

The intended loop is:

```text
task
-> clarification or execute-as-is
-> plan
-> decomposition
-> model/tool/provider selection
-> isolated sandbox/runtime execution
-> logs and artifacts
-> checks and review
-> human decision
-> apply / merge / send / continue
```

## Existing Capabilities

- Repeatable `task-run start` harness for local providerless task-runs.
- Deterministic task classification for docs review, code inspection, and general review.
- Planner/subtask artifacts, disposable workspace snapshots, executor logs, review artifacts, summary, and results.
- Local shell executor dispatch plus an opt-in Docker lane for deterministic evidence commands, with per-subtask command logs and executor reports.
- Docker task-run isolation uses a prebuilt local image, `--pull never`, disabled network, read-only workspace mounts, dropped capabilities, bounded resources, and owner-visible runtime metadata.
- External Docker task-runs support two explicit dependency modes: `--prepare-runtime none` preserves simple EXTERNAL-RUN-2 triage with the source mounted read-only, while `--prepare-runtime explicit` creates a Linux-compatible disposable dependency workspace before execution.
- Explicit preparation records its network use, lockfile hash, package manager, image identity, target platform, timestamps, and command log. The subsequent task execution remains network-disabled.
- External task-runs reject output/tmp/workspace paths inside the source repository and treat any before/after source mutation as a blocking safety failure.
- Deterministic evidence review as the default offline lane.
- First governor loop that can select and run the next local providerless task-run without per-step owner approval.
- MVP failure triage and deterministic classification.
- External command check packets and command evidence.
- Proposal readiness states that keep setup/environment failures out of code proposal readiness.
- Packet schema, packet validation, packet inspector, and static packet viewer.
- Setup/preflight policy when it prevents false code conclusions.
- External docs proposal and proposal-only patch safety model.
- Provider safety rejection for forbidden paths.
- Operator decision recording.
- Handoff packet, replay/audit, and archive evidence.
- Lifecycle reports and OKF/skills inventory as internal context.

## Alpha-19 Through Alpha-27 Reframing

Alpha-19 through Alpha-27 produced:

- setup/preflight;
- packets/evidence;
- handoff;
- audit/replay;
- archive/search/viewer;
- OKF/skills lifecycle.

This is not the product highway. It is safety/evidence substrate for Agent OS. These layers should be reused only when they help a task run from intake through isolated execution, verification, aggregation, and human decision.

## Completed Task-Run Evidence

- `TASK-RUN-1`: first manual end-to-end roadmap task run completed.
- `TASK-RUN-2`: repeatable task-run harness completed.
- `TASK-RUN-3`: gap review completed; static planning and weak owner synthesis exposed.
- `TASK-RUN-4`: stale-summary/current-command guard completed.
- `GOVERNOR-1`: first self-driving roadmap loop completed.
- `TASK-RUN-5`: semantic task-specific planning / owner-decision binding completed for the non-provider implementation gap.
- `TASK-RUN-6`: roadmap/current-state synchronization from validation evidence completed.
- `TASK-RUN-7`: Docker-isolated task execution lane completed and validated on a real local Docker runtime.

## Current Gaps

- Runtime selection beyond local host and Docker evidence commands, including full coding-agent, VPS, or other isolated execution lanes.
- Executor assignment to CLI agents, models, shell tools, integrations, or providers.
- Aggregation/compression across subtask logs and artifacts.
- Richer semantic planning beyond current deterministic heuristics.
- Stronger owner-ready synthesis across long or multi-domain task-runs.
- Docs-review planning still needs fresher validation evidence selection; TASK-RUN-6 showed next-milestone readiness evidence still querying TASK-RUN-4 while current evidence reaches TASK-RUN-6.
- Apply / merge / send / continue controls remain owner-gated and are not autonomous.

## Frozen

- Alpha-28 trends.
- New viewer/dashboard/archive features.
- New handoff/audit features.
- New OKF/skills lifecycle features.
- New safety layers without direct connection to task execution.
- Internal artifact work that does not improve local providerless task execution, evidence, verification, or owner decisions.
- Push, merge, deploy, DB/prod access, secrets, or provider config without owner approval.

## Evidence Sources Used

- `README.md`
- `docs/concept.md`
- `docs/mvp-scope.md`
- `docs/product-scope.md`
- `docs/focused-roadmap.md`
- `docs/alpha-snapshot-2026-07-02.md`
- `validation/runs/ALPHA-15/summary.md`
- `validation/runs/ALPHA-19/summary.md`
- `validation/runs/ALPHA-21/summary.md`
- `validation/runs/ALPHA-22/summary.md`
- `validation/runs/ALPHA-23/summary.md`
- `validation/runs/ALPHA-27/summary.md`
- `validation/runs/TASK-RUN-1/summary.md`
- `validation/runs/TASK-RUN-2/summary.md`
- `validation/runs/TASK-RUN-3/summary.md`
- `validation/runs/TASK-RUN-4/summary.md`
- `validation/runs/GOVERNOR-1/summary.md`
- `validation/runs/TASK-RUN-5/summary.md`
- `validation/runs/TASK-RUN-6/summary.md`

## Immediate Constraint

Do not continue Alpha-28. EXTERNAL-RUN-2 proved simple external-repository Docker triage, and EXTERNAL-RUN-3 is implemented and remains draft/in review in PR #47 until merged. After merge, the next large milestone is safe disposable repair execution; stop before applying anything to the original repo and continue to stop for secrets, provider config, push/merge/deploy, DB/prod, Alpha-28, full coding-agent runtime expansion, or another strategic fork.
