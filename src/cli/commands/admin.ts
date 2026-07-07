import { Command, InvalidArgumentError } from "commander";
import { readFile } from "node:fs/promises";
import { buildAdminUi } from "../../admin/builder.js";
import { diffAdminConfigs, saveAdminConfigDraft, validateAdminConfigDraft } from "../../admin/config-edit.js";
import {
  defaultAdminConfig,
  defaultAdminConfigPath,
  loadAdminConfig,
  upsertProvider,
  upsertRepository,
  writeAdminConfig,
  type AdminConfig
} from "../../admin/config.js";
import { redactJson } from "../../admin/redaction.js";
import { startAdminServer } from "../../admin/server.js";

export function adminCommand(): Command {
  const admin = new Command("admin").description("Build and configure the local RunForge Admin UI.");
  admin.addCommand(buildCommand());
  admin.addCommand(demoCommand());
  admin.addCommand(serveCommand());
  admin.addCommand(configCommand());
  admin.addCommand(repoCommand());
  admin.addCommand(providerCommand());
  return admin;
}

function buildCommand(): Command {
  return new Command("build")
    .description("Build the local static operator console.")
    .option("--config <config-json>", "admin config path")
    .requiredOption("--out <out-dir>", "output directory for index.html and admin-data.json")
    .action(async (opts) => {
      try {
        const result = await buildAdminUi({
          config: opts.config as string | undefined,
          out: opts.out as string
        });
        console.log(`Admin UI written: ${result.indexPath}`);
        console.log(`Admin data written: ${result.dataPath}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function demoCommand(): Command {
  return new Command("demo")
    .description("Create a temporary config and build the Admin UI under /tmp.")
    .option("--out <out-dir>", "output directory", "/tmp/runforge-admin-ui")
    .action(async (opts) => {
      try {
        const configPath = "/tmp/runforge-admin-ui-config.json";
        const config: AdminConfig = {
          ...defaultAdminConfig(),
          repositories: [
            {
              id: "runforge",
              name: "RunForge",
              path: process.cwd(),
              tags: ["self", "admin-ui-2"]
            },
            {
              id: "missing-demo",
              name: "Missing demo repo",
              path: "/tmp/runforge-admin-ui-2/missing-repo",
              tags: ["missing", "demo"]
            }
          ],
          providers: [
            {
              id: "openrouter",
              type: "openrouter",
              enabled: false,
              apiKeyRef: "env:OPENROUTER_API_KEY",
              defaultModel: null
            },
            {
              id: "codex-cli",
              type: "cli",
              enabled: false,
              command: "codex"
            }
          ],
          runs: {
            defaultRoots: ["validation/runs", "/tmp/runforge-admin-ui-2/runs"]
          }
        };
        await writeAdminConfig(configPath, config);
        const validation = await validateAdminConfigDraft(config, process.cwd());
        const diff = diffAdminConfigs(defaultAdminConfig(), config);
        const result = await buildAdminUi({
          config: configPath,
          out: opts.out as string
        });
        console.log(`Admin demo config: ${configPath}`);
        console.log(`Admin UI path: ${result.indexPath}`);
        console.log(`Admin data path: ${result.dataPath}`);
        console.log(`Repos: ${result.data.overview.repositoryCount}`);
        console.log(`Providers: ${result.data.overview.providerCount}`);
        console.log(`Runs: ${result.data.overview.indexedRunCount}`);
        console.log(`Validation diagnostics: ${validation.diagnostics.length}`);
        console.log(`Diff summary items: ${diff.summary.length}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function serveCommand(): Command {
  return new Command("serve")
    .description("Serve the local Admin UI and safe config endpoints on localhost.")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .option("--out <out-dir>", "static output directory", "/tmp/runforge-admin-ui")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "port, 0 for random", parseInteger, 0)
    .action(async (opts) => {
      try {
        const result = await startAdminServer({
          config: opts.config as string,
          out: opts.out as string,
          host: opts.host as string,
          port: opts.port as number
        });
        console.log(`Admin UI URL: ${result.url}`);
        console.log(`Admin config path: ${result.configPath}`);
        console.log(`Admin output path: ${result.outputPath}`);
        await new Promise<void>((resolve) => {
          process.once("SIGINT", () => {
            result.server.close(() => resolve());
          });
          process.once("SIGTERM", () => {
            result.server.close(() => resolve());
          });
        });
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function configCommand(): Command {
  const command = new Command("config").description("Manage local admin config.");
  command.addCommand(new Command("init")
    .description("Write a safe starter config.")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .option("--force", "overwrite an existing config")
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        if (loaded.exists && !opts.force) throw new Error(`Config already exists at ${loaded.path}. Pass --force to overwrite.`);
        await writeAdminConfig(loaded.path, defaultAdminConfig());
        console.log(`Admin config written: ${loaded.path}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  command.addCommand(new Command("show")
    .description("Print the redacted admin config.")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        console.log(JSON.stringify(redactJson({
          path: loaded.path,
          exists: loaded.exists,
          config: loaded.config
        }), null, 2));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  command.addCommand(new Command("validate")
    .description("Validate a redacted admin config draft.")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .option("--draft <draft-json>", "draft config path")
    .action(async (opts) => {
      try {
        const draft = opts.draft ? JSON.parse(await readFile(opts.draft as string, "utf8")) : (await loadAdminConfig(opts.config as string)).config;
        const result = await validateAdminConfigDraft(draft, process.cwd());
        console.log(JSON.stringify(redactJson(result), null, 2));
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  command.addCommand(new Command("diff")
    .description("Preview a redacted diff between current config and a draft.")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .requiredOption("--draft <draft-json>", "draft config path")
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        const validation = await validateAdminConfigDraft(JSON.parse(await readFile(opts.draft as string, "utf8")), process.cwd());
        console.log(JSON.stringify(redactJson({
          diagnostics: validation.diagnostics,
          diff: diffAdminConfigs(loaded.config, validation.normalized)
        }), null, 2));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  command.addCommand(new Command("save")
    .description("Validate and atomically save a draft to the local admin config path.")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .requiredOption("--draft <draft-json>", "draft config path")
    .option("--no-backup", "skip .bak backup")
    .action(async (opts) => {
      try {
        const result = await saveAdminConfigDraft({
          configPath: opts.config as string,
          draft: JSON.parse(await readFile(opts.draft as string, "utf8")),
          repoRoot: process.cwd(),
          backup: opts.backup !== false
        });
        console.log(JSON.stringify(redactJson(result), null, 2));
        if (!result.saved) process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  return command;
}

function repoCommand(): Command {
  const command = new Command("repo").description("Manage configured repositories.");
  command.addCommand(new Command("add")
    .description("Add or update a repository in local admin config.")
    .requiredOption("--id <id>", "repository id")
    .requiredOption("--path <path>", "repository path")
    .option("--name <name>", "display name")
    .option("--tag <tag...>", "repository tag")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        const config = upsertRepository(loaded.config, {
          id: opts.id as string,
          name: (opts.name as string | undefined) ?? (opts.id as string),
          path: opts.path as string,
          tags: Array.isArray(opts.tag) ? opts.tag as string[] : []
        });
        await writeAdminConfig(loaded.path, config);
        console.log(`Repository configured: ${opts.id}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  command.addCommand(new Command("remove")
    .description("Remove a repository from local admin config.")
    .requiredOption("--id <id>", "repository id")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        await writeAdminConfig(loaded.path, {
          ...loaded.config,
          repositories: loaded.config.repositories.filter((repo) => repo.id !== opts.id)
        });
        console.log(`Repository removed: ${opts.id}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  return command;
}

function providerCommand(): Command {
  const command = new Command("provider").description("Manage provider references.");
  command.addCommand(new Command("add-openrouter")
    .description("Add or update an OpenRouter provider using an env-var reference.")
    .option("--id <id>", "provider id", "openrouter")
    .option("--api-key-ref <ref>", "token reference", "env:OPENROUTER_API_KEY")
    .option("--default-model <model>", "default model")
    .option("--enabled", "mark provider enabled")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .action(async (opts) => {
      try {
        if (!String(opts.apiKeyRef).startsWith("env:")) throw new Error("OpenRouter MVP only accepts env: token references.");
        const loaded = await loadAdminConfig(opts.config as string);
        const config = upsertProvider(loaded.config, {
          id: opts.id as string,
          type: "openrouter",
          enabled: Boolean(opts.enabled),
          apiKeyRef: opts.apiKeyRef as string,
          defaultModel: (opts.defaultModel as string | undefined) ?? null
        });
        await writeAdminConfig(loaded.path, config);
        console.log(`OpenRouter provider configured: ${opts.id}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  command.addCommand(new Command("add-cli")
    .description("Add or update a CLI provider command reference.")
    .option("--id <id>", "provider id", "codex-cli")
    .requiredOption("--command <command>", "provider command")
    .option("--enabled", "mark provider enabled")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        const config = upsertProvider(loaded.config, {
          id: opts.id as string,
          type: "cli",
          enabled: Boolean(opts.enabled),
          command: opts.command as string
        });
        await writeAdminConfig(loaded.path, config);
        console.log(`CLI provider configured: ${opts.id}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  command.addCommand(new Command("remove")
    .description("Remove a provider from local admin config.")
    .requiredOption("--id <id>", "provider id")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        await writeAdminConfig(loaded.path, {
          ...loaded.config,
          providers: loaded.config.providers.filter((provider) => provider.id !== opts.id)
        });
        console.log(`Provider removed: ${opts.id}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    }));
  return command;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new InvalidArgumentError("Expected a non-negative integer.");
  return parsed;
}
