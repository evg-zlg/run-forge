import { Command, InvalidArgumentError } from "commander";
import { buildAdminUi } from "../../admin/builder.js";
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

export function adminCommand(): Command {
  const admin = new Command("admin").description("Build and configure the local RunForge Admin UI.");
  admin.addCommand(buildCommand());
  admin.addCommand(demoCommand());
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
          repositories: [{
            id: "runforge",
            name: "RunForge",
            path: process.cwd(),
            tags: ["self", "admin-alpha"]
          }],
          runs: {
            defaultRoots: ["validation/runs"]
          }
        };
        await writeAdminConfig(configPath, config);
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
  return command;
}
