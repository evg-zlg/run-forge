import { Command, InvalidArgumentError } from "commander";
import { buildDoctorReport, renderDoctor } from "../../product/doctor.js";

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Check RunForge and optional target-repository readiness without changing either repository.")
    .option("--repo <path>", "target repository to inspect")
    .option("--format <format>", "output format: human or json", "human")
    .option("--artifact-root <path>", "planned artifact root to validate")
    .option("--runtime <runtime>", "planned runtime: local or docker")
    .option("--docker-image <image>", "local image required by Docker runtime", "runforge:local")
    .option("--publication <mode>", "planned publication: none or draft-pr", "none")
    .action(async (opts) => {
      const format = parseChoice(opts.format, ["human", "json"], "--format");
      const runtime = opts.runtime === undefined ? undefined : parseChoice(opts.runtime, ["local", "docker"], "--runtime");
      const publication = parseChoice(opts.publication, ["none", "draft-pr"], "--publication");
      const report = await buildDoctorReport({ repo: opts.repo, artifactRoot: opts.artifactRoot, runtime, dockerImage: opts.dockerImage, publication });
      console.log(format === "json" ? JSON.stringify(report, null, 2) : renderDoctor(report));
      if (report.status === "blocked") process.exitCode = 2;
    });
}

function parseChoice<T extends string>(value: string, choices: readonly T[], flag: string): T {
  if (choices.includes(value as T)) return value as T;
  throw new InvalidArgumentError(`${flag} must be one of: ${choices.join(", ")}.`);
}
